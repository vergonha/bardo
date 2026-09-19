// audio output that follows the system default device.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait};
use librespot_playback::audio_backend::{Sink, SinkError, SinkResult};
use librespot_playback::convert::Converter;
use librespot_playback::decoder::AudioPacket;
use librespot_playback::{NUM_CHANNELS, SAMPLE_RATE};

use crate::blog;

static PREFERRED: Mutex<Option<String>> = Mutex::new(None);
const CHECK_INTERVAL: Duration = Duration::from_secs(2);
const QUEUE_LIMIT: usize = 26;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn preferred() -> Option<String> {
    lock(&PREFERRED).clone()
}

pub fn set_preferred(name: Option<String>) {
    let name = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    blog!("[bardo   sink] output device set to {name:?}");
    *lock(&PREFERRED) = name;
}

pub fn output_devices() -> Vec<String> {
    cpal::default_host()
        .output_devices()
        .map(|devices| devices.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

fn default_output_name() -> Option<String> {
    cpal::default_host()
        .default_output_device()
        .and_then(|d| d.name().ok())
}

struct DefaultWatch(Arc<Mutex<Option<String>>>);

impl DefaultWatch {
    fn start() -> Self {
        let shared = Arc::new(Mutex::new(default_output_name()));
        let weak = Arc::downgrade(&shared);

        let spawned = thread::Builder::new()
            .name("audio-default-watch".into())
            .spawn(move || {
                while let Some(shared) = weak.upgrade() {
                    let name = default_output_name();
                    *lock(&shared) = name;
                    drop(shared);
                    thread::sleep(CHECK_INTERVAL);
                }
            });

        if let Err(e) = spawned {
            blog!("[bardo   sink] cannot watch the default output: {e}");
        }

        Self(shared)
    }

    fn name(&self) -> Option<String> {
        lock(&self.0).clone()
    }

    fn ask(&self) -> Option<String> {
        let name = default_output_name();
        *lock(&self.0) = name.clone();
        name
    }
}

struct Output {
    sink: rodio::Sink,
    _stream: rodio::OutputStream,
    device_name: Option<String>,
    opened_for: Option<String>,
    failed: Arc<AtomicBool>,
}

pub struct FollowingSink {
    output: Option<Output>,
    watch: DefaultWatch,
}

impl FollowingSink {
    pub fn new() -> Self {
        Self {
            output: None,
            watch: DefaultWatch::start(),
        }
    }

    fn stale(&self, preferred: &Option<String>) -> bool {
        let Some(output) = &self.output else {
            return false;
        };
        output.failed.load(Ordering::Relaxed)
            || *preferred != output.opened_for
            || (preferred.is_none()
                && self
                    .watch
                    .name()
                    .is_some_and(|now| Some(&now) != output.device_name.as_ref()))
    }

    fn ensure_open(&mut self) -> SinkResult<()> {
        let preferred = preferred();

        if self.stale(&preferred) {
            self.output = None;
        }
        if self.output.is_some() {
            return Ok(());
        }

        match open_output(preferred) {
            Ok(output) => {
                self.output = Some(output);
                Ok(())
            }
            Err(e) => {
                blog!("[bardo   sink] {e}");
                Err(SinkError::ConnectionRefused(e))
            }
        }
    }
}

impl Sink for FollowingSink {
    fn start(&mut self) -> SinkResult<()> {
        self.watch.ask();
        self.ensure_open()?;
        if let Some(output) = &self.output {
            output.sink.play();
        }
        Ok(())
    }

    fn stop(&mut self) -> SinkResult<()> {
        if let Some(output) = &self.output {
            output.sink.sleep_until_end();
            output.sink.pause();
        }
        Ok(())
    }

    fn write(&mut self, packet: AudioPacket, converter: &mut Converter) -> SinkResult<()> {
        let samples = packet
            .samples()
            .map_err(|e| SinkError::OnWrite(e.to_string()))?;
        let samples: &[f32] = &converter.f64_to_f32(samples);

        self.ensure_open()?;
        let Some(output) = &self.output else {
            return Err(SinkError::NotConnected("no audio output is open".into()));
        };

        output.sink.append(rodio::buffer::SamplesBuffer::new(
            NUM_CHANNELS as rodio::ChannelCount,
            SAMPLE_RATE,
            samples,
        ));

        // let rodio drain, otherwise the whole track decodes into memory at once
        while output.sink.len() > QUEUE_LIMIT {
            if output.failed.load(Ordering::Relaxed) {
                break; // the next write reopens on a working device
            }
            thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    }
}
fn open_stream(
    device: &cpal::Device,
    on_error: impl FnMut(cpal::StreamError) + Send + Clone + 'static,
) -> Result<rodio::OutputStream, rodio::StreamError> {
    let builder = |rate: u32| -> Result<_, rodio::StreamError> {
        Ok(rodio::OutputStreamBuilder::from_device(device.clone())?
            .with_channels(NUM_CHANNELS as rodio::ChannelCount)
            .with_sample_rate(rate as rodio::SampleRate)
            .with_error_callback(on_error.clone()))
    };

    if let Ok(stream) = builder(SAMPLE_RATE)?.open_stream() {
        return Ok(stream);
    }
    if let Ok(config) = device.default_output_config() {
        if let Ok(stream) = builder(config.sample_rate().0)?.open_stream() {
            return Ok(stream);
        }
    }
    builder(SAMPLE_RATE)?.open_stream_or_fallback()
}

fn open_output(preferred: Option<String>) -> Result<Output, String> {
    let host = cpal::default_host();

    let device = match preferred.as_deref() {
        Some(name) => host
            .output_devices()
            .map_err(|e| format!("cannot list the audio devices: {e}"))?
            .find(|d| d.name().is_ok_and(|found| found == name))
            .or_else(|| {
                blog!("[bardo   sink] device {name:?} is not available; using the default");
                host.default_output_device()
            }),
        None => host.default_output_device(),
    }
    .ok_or_else(|| "no audio output device is available".to_string())?;

    let device_name = device.name().ok();
    blog!(
        "[bardo   sink] audio output: {}",
        device_name.as_deref().unwrap_or("[unknown device]")
    );

    let failed = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&failed);
    let mut stream = open_stream(&device, move |e: cpal::StreamError| {
        eprintln!("[bardo   sink] audio stream error: {e}");
        flag.store(true, Ordering::Relaxed);
    })
    .map_err(|e| format!("cannot open the audio output: {e}"))?;
    stream.log_on_drop(false);

    let sink = rodio::Sink::connect_new(stream.mixer());

    Ok(Output {
        sink,
        _stream: stream,
        device_name,
        opened_for: preferred,
        failed,
    })
}
