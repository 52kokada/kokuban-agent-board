"""Private stdio worker. One offline model, one transcription at a time."""
import argparse
import gc
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import threading

MAX_LINE = 65536
SAMPLE_RATE = 16000


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def memory():
    """Windows working set / private committed bytes; no extra runtime dependency."""
    if sys.platform != 'win32':
        return {}
    import ctypes
    from ctypes import wintypes

    class Counters(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
            (name, ctypes.c_size_t) for name in [
                'PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage',
                'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
                'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage',
                'PrivateUsage']]

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    psapi = ctypes.WinDLL('psapi', use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
    values = Counters()
    values.cb = ctypes.sizeof(values)
    if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(values), values.cb):
        return {}
    return {'rssBytes': values.WorkingSetSize, 'peakRssBytes': values.PeakWorkingSetSize,
            'privateBytes': values.PrivateUsage, 'cpuSeconds': time.process_time()}


class JobError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class BusyMemory:
    """Opt-in measurement for integration evidence, never a resident polling loop."""
    def __init__(self):
        self.values = {'peakRssBytes': 0, 'peakPrivateBytes': 0}
        self.stop = threading.Event()
        self.thread = None

    def sample(self):
        values = memory()
        self.values['peakRssBytes'] = max(self.values['peakRssBytes'], values.get('rssBytes', 0))
        self.values['peakPrivateBytes'] = max(self.values['peakPrivateBytes'], values.get('privateBytes', 0))

    def start(self):
        if os.environ.get('VOICE_MEASURE') != '1':
            return
        def loop():
            self.sample()
            while not self.stop.wait(0.05):
                self.sample()
        self.thread = threading.Thread(target=loop, daemon=True)
        self.thread.start()

    def finish(self):
        if self.thread:
            self.sample()
            self.stop.set()
            self.thread.join()
            return self.values
        return None


def validate_path(value, root, max_bytes):
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise JobError('INVALID_PATH', 'An absolute attachment path is required.')
    # Reject foreign drives / UNC paths lexically before touching their files.
    # Still resolve afterward to catch junctions, symlinks and '..' escapes.
    if not Path(os.path.abspath(value)).is_relative_to(root):
        raise JobError('PATH_OUTSIDE_ROOT', 'Audio must be inside the configured attachment root.')
    try:
        path = Path(value).resolve(strict=True)
    except (OSError, ValueError):
        raise JobError('FILE_NOT_FOUND', 'The audio attachment is unavailable.')
    if not path.is_relative_to(root):
        raise JobError('PATH_OUTSIDE_ROOT', 'Audio must be inside the configured attachment root.')
    if not path.is_file():
        raise JobError('INVALID_PATH', 'Audio must be a regular file.')
    if not 0 < path.stat().st_size <= max_bytes:
        raise JobError('FILE_SIZE_LIMIT', 'Audio is empty or exceeds the upload size limit.')
    return path


def decode_bounded(path, max_seconds):
    # Decode the first audio stream via bundled FFmpeg. Do not trust filename,
    # MIME type or container duration; cap actual decoded samples before ASR.
    import av
    import numpy as np
    chunks = []
    count = 0
    limit = int(max_seconds * SAMPLE_RATE)
    try:
        with av.open(str(path), mode='r', metadata_errors='ignore') as container:
            if not container.streams.audio:
                raise JobError('NO_AUDIO', 'The attachment has no audio stream.')
            stream = container.streams.audio[0]
            stream.thread_type = 'AUTO'
            resampler = av.AudioResampler(format='s16', layout='mono', rate=SAMPLE_RATE)
            for frame in container.decode(stream):
                for converted in resampler.resample(frame):
                    count += converted.samples
                    if count > limit:
                        raise JobError('DURATION_LIMIT', 'Audio exceeds the voice-note duration limit.')
                    chunks.append(converted.to_ndarray().reshape(-1).astype(np.float32) / 32768.0)
            for converted in resampler.resample(None):
                count += converted.samples
                if count > limit:
                    raise JobError('DURATION_LIMIT', 'Audio exceeds the voice-note duration limit.')
                chunks.append(converted.to_ndarray().reshape(-1).astype(np.float32) / 32768.0)
    except JobError:
        raise
    except Exception:
        raise JobError('DECODE_FAILED', 'The audio attachment could not be decoded.') from None
    if count == 0:
        raise JobError('NO_AUDIO', 'The attachment contains no audio samples.')
    audio = np.concatenate(chunks)
    return audio


def main():
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError('Voice worker requires Python 3.12')
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--audio-root', required=True)
    parser.add_argument('--threads', type=int, default=8)
    parser.add_argument('--max-seconds', type=float, default=300)
    parser.add_argument('--max-bytes', type=int, default=25 * 1024 * 1024)
    args = parser.parse_args()
    if not 1 <= args.threads <= 16 or not math.isfinite(args.max_seconds) or not 1 <= args.max_seconds <= 600 or not 1 <= args.max_bytes <= 100 * 1024 * 1024:
        parser.error('Invalid resource limits')
    root = Path(args.audio_root).resolve(strict=True)
    model_path = Path(args.model_dir).resolve(strict=True)
    if not root.is_dir() or not model_path.is_dir():
        parser.error('Model and audio root must be directories')
    from faster_whisper import WhisperModel
    started = time.perf_counter()
    model = WhisperModel(str(model_path), device='cpu', compute_type='int8',
                         cpu_threads=args.threads, num_workers=1, local_files_only=True)
    emit({'type': 'ready', 'protocol': 1, 'pid': os.getpid(), 'model': os.environ.get('VOICE_MODEL_NAME', 'small'),
          'device': 'cpu', 'computeType': 'int8', 'threads': args.threads,
          'loadSeconds': time.perf_counter() - started, 'resources': memory()})
    completed = 0
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not line:
            break
        if len(line) > MAX_LINE:
            # A protocol violation is fatal; don't parse a partial next request.
            raise RuntimeError('Protocol line exceeds limit')
        request_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or not isinstance(request.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', request['id']):
                raise JobError('INVALID_REQUEST', 'A valid request ID is required.')
            request_id = request['id']
            if request.get('op') == 'stats':
                emit({'type': 'result', 'id': request_id,
                      'data': {'completed': completed, 'resources': memory()}})
                continue
            if request.get('op') != 'transcribe':
                raise JobError('INVALID_REQUEST', 'Unknown operation.')
            language = request.get('language')
            if language is not None and (not isinstance(language, str) or not re.fullmatch(r'[a-z]{2,3}', language)):
                raise JobError('INVALID_LANGUAGE', 'Use an ISO language code or omit it for detection.')
            vocabulary = request.get('vocabulary', [])
            if (not isinstance(vocabulary, list) or len(vocabulary) > 64
                or any(not isinstance(word, str) or not word.strip() or len(word) > 64 for word in vocabulary)
                or sum(len(word) for word in vocabulary) > 2048):
                raise JobError('INVALID_VOCABULARY', 'Use at most 64 short personal vocabulary terms (2048 characters total).')
            path = validate_path(request.get('path'), root, args.max_bytes)
            wall, cpu = time.perf_counter(), time.process_time()
            measured = BusyMemory()
            measured.start()
            audio = None
            try:
                audio = decode_bounded(path, args.max_seconds)
                decoded = time.perf_counter()
                segments, info = model.transcribe(audio, language=language, beam_size=5,
                    task='transcribe', multilingual=language is None,
                    hotwords=', '.join(vocabulary) or None,
                    vad_filter=True, condition_on_previous_text=False)
                text = ''.join(segment.text for segment in segments).strip()
                duration = len(audio) / SAMPLE_RATE
                data = {'text': text, 'language': info.language,
                        'languageProbability': info.language_probability,
                        'durationSeconds': duration,
                        'timing': {'decodeSeconds': decoded - wall,
                                   'transcribeSeconds': time.perf_counter() - decoded,
                                   'totalSeconds': time.perf_counter() - wall,
                                   'cpuSeconds': time.process_time() - cpu}}
            finally:
                del audio
                gc.collect()
                busy_memory = measured.finish()
            completed += 1
            data['resources'] = memory()
            if busy_memory:
                data['busyResources'] = busy_memory
            emit({'type': 'result', 'id': request_id, 'data': data})
        except JobError as error:
            emit({'type': 'error', 'id': request_id, 'code': error.code, 'message': str(error)})
        except Exception:
            emit({'type': 'error', 'id': request_id, 'code': 'TRANSCRIPTION_FAILED',
                  'message': 'Local transcription failed; the original audio is preserved.'})


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        main()
    except Exception as error:
        print(f'Voice worker stopped: {type(error).__name__}: {error}', file=sys.stderr, flush=True)
        sys.exit(1)
