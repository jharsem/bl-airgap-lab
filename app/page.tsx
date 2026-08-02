import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import DecoderWorker from "./optical/decoder.worker?worker&inline";
import { LTDecoder, LTEncoder } from "./optical/fountain";
import {
  fnv1a, packCalibrationControl, packCalibrationData, packFrame,
  maxPayloadForBlock, parseCalibrationPacket, parseFrame, sameFrameStream,
  type CalibrationEvent, type CalibrationPacket, type FrameHeader, type FrameSeal,
} from "./optical/protocol";
import { fingerprint, seal as sealPayload, sha256, unseal } from "./optical/crypto";

type Mode = "send" | "receive";
type ErrorLevel = "L" | "M";
type UnsealState = "locked" | "working" | "failed" | "open";
type SourceModel = {
  bytes: Uint8Array;
  /** What the fountain actually codes: ciphertext when sealed, otherwise the payload. */
  transmit: Uint8Array;
  name: string;
  sessionId: number;
  payloadFnv: number;
  blockLen: number;
  seal?: FrameSeal;
  digest: string;
};
type CalibrationResult = { run: number; profile: number; profiles: number; name: string; sequence: number; blockSize: number; fps: number; duration: number; unique: number; reads: number };
type QrImage = { image: ImageData; version: number; modules: number; sequence: number };

const PRESETS = [
  { name: "Reliable", blockSize: 980, fps: 15, level: "L" as ErrorLevel },
  { name: "Balanced", blockSize: 1445, fps: 24, level: "L" as ErrorLevel },
  { name: "Aggressive", blockSize: 2311, fps: 30, level: "L" as ErrorLevel },
];

const SWEEP_DURATION = 4000;
const SWEEP_PROFILES = [
  { name: "Conservative", blockSize: 700, fps: 12, level: "M" as ErrorLevel },
  { name: "Reliable", blockSize: 980, fps: 15, level: "L" as ErrorLevel },
  { name: "Balanced", blockSize: 1445, fps: 24, level: "L" as ErrorLevel },
  { name: "Fast", blockSize: 1830, fps: 24, level: "L" as ErrorLevel },
  { name: "Maximum", blockSize: 2311, fps: 30, level: "L" as ErrorLevel },
];

const QR_MARGIN = 4;
const GCM_TAG_LEN = 16;

function payloadIssue(bytes: Uint8Array, blockLen: number, sealed: boolean): string | null {
  if (bytes.length === 0) return "Empty files are not supported.";
  const maximum = maxPayloadForBlock(blockLen) - (sealed ? GCM_TAG_LEN : 0);
  if (bytes.length > maximum) {
    return `This configuration supports files up to ${formatBytes(maximum)}. Choose a larger frame size or a smaller file.`;
  }
  return null;
}

function createQrImage(bytes: Uint8Array, errorLevel: ErrorLevel, sequence: number, version?: number): QrImage {
  const qr = QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
    errorCorrectionLevel: errorLevel, version, maskPattern: 4,
  });
  const modules = qr.modules.size;
  const total = modules + QR_MARGIN * 2;
  const image = new ImageData(total, total);
  const pixels = new Uint32Array(image.data.buffer);
  pixels.fill(0xffffffff);
  for (let y = 0; y < modules; y += 1) {
    const row = (y + QR_MARGIN) * total + QR_MARGIN;
    for (let x = 0; x < modules; x += 1) if (qr.modules.data[y * modules + x]) pixels[row + x] = 0xff1c1b10;
  }
  return { image, version: qr.version, modules, sequence };
}

function renderQrImage(canvas: HTMLCanvasElement, frame: QrImage) {
  const staging = document.createElement("canvas");
  staging.width = frame.image.width; staging.height = frame.image.height;
  staging.getContext("2d")!.putImageData(frame.image, 0, 0);
  const dpr = window.devicePixelRatio || 1;
  const cssBudget = Math.min(720, Math.max(280, (canvas.parentElement?.clientWidth ?? 560) - 44));
  const scale = Math.max(1, Math.floor(cssBudget * dpr / frame.image.width));
  canvas.width = frame.image.width * scale; canvas.height = frame.image.height * scale;
  canvas.style.width = `${canvas.width / dpr}px`; canvas.style.height = `${canvas.height / dpr}px`;
  const context = canvas.getContext("2d")!;
  context.imageSmoothingEnabled = false;
  context.drawImage(staging, 0, 0, canvas.width, canvas.height);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function Metric({ value, label }: { value: string; label: string }) {
  return <div className="metric"><strong>{value}</strong><span>{label}</span></div>;
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("send");
  const [chunkSize, setChunkSize] = useState(1445);
  const [targetFps, setTargetFps] = useState(24);
  const [errorLevel, setErrorLevel] = useState<ErrorLevel>("L");
  const [payloadSize, setPayloadSize] = useState(64);
  const [payloadError, setPayloadError] = useState("");
  const [model, setModel] = useState<SourceModel | null>(null);
  const [sending, setSending] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationStatus, setCalibrationStatus] = useState({ profile: 0, progress: 0 });
  const [calibrationResults, setCalibrationResults] = useState<CalibrationResult[]>([]);
  const [calibrationComplete, setCalibrationComplete] = useState(false);
  const [sendIndex, setSendIndex] = useState(0);
  const [displayFps, setDisplayFps] = useState(0);
  const [cameraState, setCameraState] = useState<"idle" | "starting" | "running" | "error">("idle");
  const [cameraError, setCameraError] = useState("");
  const [cameraInfo, setCameraInfo] = useState("");
  const [receiveStats, setReceiveStats] = useState({ rank: 0, total: 0, unique: 0, bytes: 0, elapsed: 0, scans: 0 });
  const [completeData, setCompleteData] = useState<Uint8Array | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [sealPassphrase, setSealPassphrase] = useState("");
  const [sealing, setSealing] = useState(false);
  const [receivePassphrase, setReceivePassphrase] = useState("");
  const [sealedRaw, setSealedRaw] = useState<Uint8Array | null>(null);
  const [sealedParams, setSealedParams] = useState<FrameSeal | null>(null);
  const [unsealState, setUnsealState] = useState<UnsealState>("locked");
  const [receivedDigest, setReceivedDigest] = useState("");
  const qrCanvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const scanCanvas = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const decoderWorkers = useRef<Worker[]>([]);
  const workerBusy = useRef<boolean[]>([]);
  const captureGeneration = useRef(0);
  const frameCounter = useRef(0);
  const decoder = useRef<LTDecoder | null>(null);
  const decoderHeader = useRef<FrameHeader | null>(null);
  const decoderSession = useRef(0);
  const transferDone = useRef(false);
  const equationCounter = useRef(0);
  const calibrationRun = useRef(0);
  const calibrationSeen = useRef<Map<number, Set<number>>>(new Map());
  const calibrationReads = useRef<Map<number, number>>(new Map());
  const calibrationLocked = useRef(false);
  const activeCalibrationRun = useRef(0);
  const receiveStarted = useRef(0);
  const initialized = useRef(false);

  const buildPayload = useCallback(async (
    bytes: Uint8Array, name: string, nextBlockSize = chunkSize, phrase = sealPassphrase,
  ) => {
    equationCounter.current = 0;
    setSending(false);
    const issue = payloadIssue(bytes, nextBlockSize, Boolean(phrase));
    if (issue) {
      setPayloadError(`${issue} The previous payload is unchanged.`);
      return false;
    }
    const sessionBytes = new Uint16Array(1);
    do crypto.getRandomValues(sessionBytes); while (sessionBytes[0] === 0);
    const sessionId = sessionBytes[0];
    setPayloadError("");
    setSealing(Boolean(phrase));
    try {
      // Fingerprint the plaintext, so the value shown here is comparable with
      // the one the receiver shows after a successful open.
      const digest = fingerprint(await sha256(bytes));
      let transmit = bytes;
      let seal: FrameSeal | undefined;
      if (phrase) {
        const sealed = await sealPayload(bytes, phrase);
        transmit = sealed.ciphertext;
        seal = { kdf: sealed.kdf, iterations: sealed.iterations, salt: sealed.salt, nonce: sealed.nonce };
      }
      setModel({
        bytes, transmit, name, sessionId, payloadFnv: fnv1a(transmit),
        blockLen: nextBlockSize, seal, digest,
      });
      setSendIndex(0);
      setDisplayFps(0);
      return true;
    } catch (error) {
      setPayloadError(error instanceof Error ? `Could not prepare payload: ${error.message}` : "Could not prepare payload.");
      return false;
    } finally {
      setSealing(false);
    }
  }, [chunkSize, sealPassphrase]);

  const makeSynthetic = useCallback(() => {
    const bytes = new Uint8Array(payloadSize * 1024);
    crypto.getRandomValues(bytes);
    void buildPayload(bytes, `synthetic-${payloadSize}kb.bin`);
  }, [buildPayload, payloadSize]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const timer = window.setTimeout(makeSynthetic, 0);
    return () => window.clearTimeout(timer);
  }, [makeSynthetic]);

  // Sealing costs a 600k-iteration KDF, so it is bound to an explicit commit
  // rather than to keystrokes in the passphrase field.
  const applyPassphrase = useCallback((phrase: string) => {
    setSealPassphrase(phrase);
    if (model) void buildPayload(model.bytes, model.name, model.blockLen, phrase);
  }, [buildPayload, model]);

  useEffect(() => {
    if (!qrCanvas.current || !model) return;
    let cancelled = false;
    let timer = 0;
    let animation = 0;
    if (calibrating) {
      let profile = 0;
      let sequence = 0;
      let phase: CalibrationEvent | "test" = "start";
      let controlRepeat = 0;
      const drawCalibration = () => {
        if (cancelled || !qrCanvas.current) return;
        const setting = SWEEP_PROFILES[Math.min(profile, SWEEP_PROFILES.length - 1)];
        const frameCount = Math.round(setting.fps * SWEEP_DURATION / 1000);
        const phaseFps = phase === "test" ? setting.fps : 4;
        const before = performance.now();
        const payload = phase === "test"
          ? packCalibrationData(calibrationRun.current, profile, SWEEP_PROFILES.length, sequence, setting.blockSize, setting.fps, SWEEP_DURATION)
          : packCalibrationControl(calibrationRun.current, phase, profile, SWEEP_PROFILES.length, setting.blockSize, setting.fps, SWEEP_DURATION);
        renderQrImage(qrCanvas.current, createQrImage(payload, phase === "test" ? setting.level : "M", sequence));
        if (phase === "test") {
          setCalibrationStatus({ profile, progress: (profile + (sequence + 1) / frameCount) / SWEEP_PROFILES.length });
          sequence += 1;
          if (sequence >= frameCount) { phase = "end"; sequence = 0; controlRepeat = 0; }
        } else {
          controlRepeat += 1;
          const repeats = phase === "complete" ? 6 : 3;
          if (controlRepeat >= repeats) {
            controlRepeat = 0;
            if (phase === "start") phase = "test";
            else if (phase === "end") { profile += 1; phase = profile >= SWEEP_PROFILES.length ? "complete" : "start"; }
            else {
              setCalibrationStatus({ profile: SWEEP_PROFILES.length - 1, progress: 1 });
              setCalibrating(false);
              return;
            }
          }
        }
        timer = window.setTimeout(drawCalibration, Math.max(0, 1000 / phaseFps - (performance.now() - before)));
      };
      drawCalibration();
      return () => { cancelled = true; window.clearTimeout(timer); };
    }
    const encoder = new LTEncoder(model.transmit, model.blockLen, model.sessionId);
    let version: number | undefined;
    let nextSequence = equationCounter.current;
    const queue: QrImage[] = [];
    const makeFrame = () => {
      const block = encoder.encode(nextSequence);
      const bytes = packFrame({
        sessionId: model.sessionId, seq: nextSequence, k: encoder.k, blockLen: model.blockLen,
        totalLen: model.transmit.length, payloadFnv: model.payloadFnv, seal: model.seal,
      }, block);
      const frame = createQrImage(bytes, errorLevel, nextSequence, version);
      version = frame.version;
      nextSequence += 1;
      return frame;
    };
    if (!sending) {
      const frame = makeFrame();
      renderQrImage(qrCanvas.current, frame);
      setSendIndex(frame.sequence);
      return () => { cancelled = true; };
    }
    const pump = () => {
      if (cancelled) return;
      try { while (queue.length < 3) queue.push(makeFrame()); } catch { setSending(false); return; }
      timer = window.setTimeout(pump, 4);
    };
    pump();
    const started = performance.now();
    let rendered = 0;
    let lastUi = 0;
    const interval = 1000 / targetFps;
    let nextAt = performance.now();
    const tick = (now: number) => {
      if (cancelled || !qrCanvas.current) return;
      animation = requestAnimationFrame(tick);
      if (now < nextAt) return;
      const frame = queue.shift();
      if (!frame) { nextAt = now + interval; return; }
      renderQrImage(qrCanvas.current, frame);
      equationCounter.current = frame.sequence + 1;
      rendered += 1;
      if (now - lastUi > 400) {
        setSendIndex(frame.sequence);
        setDisplayFps(rendered / Math.max(0.001, (now - started) / 1000));
        lastUi = now;
      }
      nextAt += interval;
      if (now - nextAt > 3 * interval) nextAt = now + interval;
    };
    animation = requestAnimationFrame(tick);
    return () => { cancelled = true; window.clearTimeout(timer); cancelAnimationFrame(animation); };
  }, [model, sending, targetFps, errorLevel, calibrating]);

  const releaseCamera = useCallback(() => {
    captureGeneration.current += 1;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    decoderWorkers.current.forEach((worker) => worker.terminate());
    decoderWorkers.current = [];
    workerBusy.current = [];
    if (video.current) video.current.srcObject = null;
  }, []);

  const stopCamera = useCallback(() => {
    releaseCamera();
    setCameraState("idle");
  }, [releaseCamera]);

  const failCamera = useCallback((error: unknown) => {
    releaseCamera();
    setCameraState("error");
    setCameraInfo("");
    setCameraError(error instanceof Error ? error.message : "Camera access failed");
  }, [releaseCamera]);

  const resetReceiver = useCallback(() => {
    decoder.current = null;
    decoderHeader.current = null;
    decoderSession.current = 0;
    transferDone.current = false;
    calibrationSeen.current.clear();
    calibrationReads.current.clear();
    calibrationLocked.current = false;
    activeCalibrationRun.current = 0;
    receiveStarted.current = 0;
    setReceiveStats({ rank: 0, total: 0, unique: 0, bytes: 0, elapsed: 0, scans: 0 });
    setCalibrationResults([]);
    setCalibrationComplete(false);
    setCompleteData(null);
    setVerified(null);
    setSealedRaw(null);
    setSealedParams(null);
    setUnsealState("locked");
    setReceivedDigest("");
  }, []);

  const acceptCalibration = useCallback((packet: CalibrationPacket) => {
    if (packet.profiles !== SWEEP_PROFILES.length || packet.profile > SWEEP_PROFILES.length) return;
    if (packet.kind === "data" && packet.profile >= SWEEP_PROFILES.length) return;
    if (activeCalibrationRun.current !== packet.run) {
      resetReceiver();
      activeCalibrationRun.current = packet.run;
    }
    calibrationLocked.current = true;
    const placeholder = (profile: number): CalibrationResult => {
      const setting = SWEEP_PROFILES[profile];
      return {
        run: packet.run, profile, profiles: packet.profiles, name: setting.name, sequence: 0,
        blockSize: setting.blockSize, fps: setting.fps, duration: packet.duration, unique: 0, reads: 0,
      };
    };
    if (packet.kind === "data") {
      let seen = calibrationSeen.current.get(packet.profile);
      if (!seen) { seen = new Set(); calibrationSeen.current.set(packet.profile, seen); }
      seen.add(packet.sequence);
      calibrationReads.current.set(packet.profile, (calibrationReads.current.get(packet.profile) ?? 0) + 1);
      const setting = SWEEP_PROFILES[packet.profile];
      const result: CalibrationResult = {
        run: packet.run, profile: packet.profile, profiles: packet.profiles, name: setting.name,
        sequence: packet.sequence, blockSize: packet.blockLen, fps: packet.fps, duration: packet.duration,
        unique: seen.size, reads: calibrationReads.current.get(packet.profile) ?? 0,
      };
      setCalibrationResults((previous) => [...previous.filter((item) => item.profile !== packet.profile), result].sort((a, b) => a.profile - b.profile));
      return;
    }
    setCalibrationResults((previous) => {
      const next = [...previous];
      const ensure = (profile: number) => {
        if (profile < SWEEP_PROFILES.length && !next.some((item) => item.profile === profile)) next.push(placeholder(profile));
      };
      if (packet.event === "complete") {
        for (let profile = 0; profile < SWEEP_PROFILES.length; profile += 1) ensure(profile);
      } else ensure(packet.profile);
      return next.sort((a, b) => a.profile - b.profile);
    });
    if (packet.event === "complete") setCalibrationComplete(true);
  }, [resetReceiver]);

  const acceptDecoded = useCallback((bytes: Uint8Array) => {
    const calibration = parseCalibrationPacket(bytes);
    if (calibration) { acceptCalibration(calibration); return; }
    if (calibrationLocked.current || transferDone.current) return;
    const parsed = parseFrame(bytes);
    if (!parsed) return;
    const { header, block } = parsed;
    if (!decoder.current) {
      decoder.current = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
      decoderHeader.current = header;
      decoderSession.current = header.sessionId;
      receiveStarted.current = performance.now();
    }
    if (decoderSession.current !== header.sessionId || !decoderHeader.current
      || !sameFrameStream(decoderHeader.current, header)) return;
    const active = decoder.current;
    active.addFrame(header.seq, block);
    const elapsed = Math.max(0.001, (performance.now() - receiveStarted.current) / 1000);
    const expected = Math.ceil(active.k * 1.18);
    const usefulBytes = Math.min(active.totalLen, active.framesNew * active.blockLen / 1.18);
    setReceiveStats({ rank: active.framesNew, total: expected, unique: active.framesNew, bytes: usefulBytes, elapsed, scans: active.framesNew + active.framesDup });
    if (active.isComplete) {
      const payload = active.assemble();
      if (!payload) return;
      transferDone.current = true;
      setReceiveStats({
        rank: expected, total: expected, unique: active.framesNew, bytes: header.totalLen,
        elapsed, scans: active.framesNew + active.framesDup,
      });
      const intact = fnv1a(payload) === header.payloadFnv;
      if (header.seal) {
        // Reassembled ciphertext. Nothing is trusted until GCM says so, and
        // the passphrase may not have been entered yet, so hold it and wait.
        setSealedRaw(payload);
        setSealedParams(header.seal);
        setCompleteData(null);
        setVerified(null);
        setUnsealState("locked");
      } else {
        setSealedRaw(null);
        setSealedParams(null);
        setCompleteData(intact ? payload : null);
        setVerified(intact);
        void sha256(payload).then((digest) => setReceivedDigest(fingerprint(digest)));
      }
      stopCamera();
    }
  }, [acceptCalibration, stopCamera]);

  const startCamera = useCallback(async () => {
    resetReceiver();
    setCameraState("starting");
    setCameraError("");
    setCameraInfo("");
    try {
      const base: MediaTrackConstraints = { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 960 } };
      let media: MediaStream;
      try { media = await navigator.mediaDevices.getUserMedia({ video: { ...base, frameRate: { exact: 60 } }, audio: false }); }
      catch { media = await navigator.mediaDevices.getUserMedia({ video: { ...base, frameRate: { ideal: 60 } }, audio: false }); }
      stream.current = media;
      if (!video.current) throw new Error("Camera preview is unavailable");
      video.current.srcObject = media;
      await video.current.play();
      setCameraState("running");
      const settings = media.getVideoTracks()[0]?.getSettings();
      setCameraInfo(`${settings?.width ?? "?"}×${settings?.height ?? "?"} @ ${settings?.frameRate ?? "?"} fps · 2 WASM workers`);
      decoderWorkers.current = Array.from({ length: 2 }, (_, slot) => {
        const worker = new DecoderWorker();
        worker.onmessage = (event: MessageEvent<{ id: number; bytes: Uint8Array | null }>) => {
          if (event.data.id === -1) return;
          workerBusy.current[slot] = false;
          if (event.data.bytes) acceptDecoded(new Uint8Array(event.data.bytes));
        };
        worker.onerror = () => failCamera(new Error("QR decoder worker failed"));
        return worker;
      });
      workerBusy.current = [false, false];
      const generation = ++captureGeneration.current;
      type VideoWithCallback = HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };
      const schedule = () => {
        if (generation !== captureGeneration.current || !stream.current) return;
        const player = video.current;
        const canvas = scanCanvas.current;
        if (!player || !canvas) return;
        const capture = () => {
          if (generation !== captureGeneration.current || player.readyState < 2) return schedule();
          const slot = workerBusy.current.indexOf(false);
          if (slot >= 0 && player.videoWidth && player.videoHeight) {
            try {
              canvas.width = player.videoWidth; canvas.height = player.videoHeight;
              const context = canvas.getContext("2d", { willReadFrequently: true });
              if (!context) throw new Error("Camera capture canvas is unavailable");
              context.drawImage(player, 0, 0);
              const image = context.getImageData(0, 0, canvas.width, canvas.height);
              workerBusy.current[slot] = true;
              decoderWorkers.current[slot]?.postMessage({ id: frameCounter.current++, buffer: image.data.buffer, width: canvas.width, height: canvas.height }, [image.data.buffer]);
            } catch (error) {
              failCamera(error);
              return;
            }
          }
          schedule();
        };
        const withCallback = player as VideoWithCallback;
        if (withCallback.requestVideoFrameCallback) withCallback.requestVideoFrameCallback(capture);
        else requestAnimationFrame(capture);
      };
      schedule();
    } catch (error) {
      failCamera(error);
    }
  }, [acceptDecoded, failCamera, resetReceiver]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    if (model) {
      const issue = payloadIssue(model.bytes, preset.blockSize, Boolean(sealPassphrase));
      if (issue) { setPayloadError(`Preset not applied. ${issue}`); return; }
    }
    setChunkSize(preset.blockSize);
    setTargetFps(preset.fps);
    setErrorLevel(preset.level);
    if (model) void buildPayload(model.bytes, model.name, preset.blockSize);
  };

  const attemptUnseal = useCallback(async () => {
    if (!sealedRaw || !sealedParams || !receivePassphrase) return;
    setUnsealState("working");
    const opened = await unseal(sealedRaw, receivePassphrase, sealedParams);
    if (!opened) {
      // GCM cannot tell a wrong passphrase from an altered payload, so the UI
      // does not claim to either.
      setUnsealState("failed");
      setVerified(false);
      setCompleteData(null);
      return;
    }
    setCompleteData(opened);
    setVerified(true);
    setUnsealState("open");
    setReceivedDigest(fingerprint(await sha256(opened)));
  }, [receivePassphrase, sealedParams, sealedRaw]);

  const startCalibration = () => {
    setSending(false);
    calibrationRun.current = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
    setCalibrationStatus({ profile: 0, progress: 0 });
    setCalibrating(true);
  };

  const progress = receiveStats.total ? Math.min(1, receiveStats.rank / receiveStats.total) : 0;
  const throughput = receiveStats.elapsed ? receiveStats.bytes / receiveStats.elapsed : 0;
  const theoretical = targetFps * chunkSize;
  const recommended = calibrationResults.length ? [...calibrationResults].sort((a, b) => {
    const score = (item: CalibrationResult) => {
      const seconds = item.duration / 1000;
      const capture = item.unique / Math.max(1, item.fps * seconds);
      const goodput = item.unique * item.blockSize / seconds;
      return goodput * Math.min(1, capture / 0.55);
    };
    return score(b) - score(a);
  })[0] : null;

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#"><span className="brand-mark">AG</span><span>AirGap Lab</span></a>
        <div className="protocol"><i /> Protocol AG3 · binary LT</div>
      </header>

      <section className="intro">
        <p className="eyebrow">Optical data transfer benchmark</p>
        <h1>Measure the air gap.</h1>
        <p>Turn one screen into a transmitter and an iPhone camera into a receiver. Fountain-coded frames recover the file without waiting for specific missing codes.</p>
      </section>

      <nav className="mode-switch" aria-label="Choose device role">
        <button className={mode === "send" ? "active" : ""} onClick={() => { stopCamera(); setMode("send"); }}>Transmit</button>
        <button className={mode === "receive" ? "active" : ""} onClick={() => setMode("receive")}>Receive</button>
      </nav>

      {mode === "send" ? (
        <section className="workspace sender">
          <div className="panel controls">
            <div className="panel-heading"><span>01</span><div><h2>Configure payload</h2><p>Use generated data or choose a local file.</p></div></div>
            <label className="field"><span>Synthetic payload <b>{payloadSize} kB</b></span><input type="range" min="4" max="512" step="4" value={payloadSize} onChange={(event) => setPayloadSize(Number(event.target.value))} /></label>
            <button className="secondary" onClick={makeSynthetic}>Regenerate test data</button>
            <label className="file-picker">Choose a local file<input type="file" onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              try { await buildPayload(new Uint8Array(await file.arrayBuffer()), file.name); }
              catch (error) { setPayloadError(error instanceof Error ? `Could not read file: ${error.message}` : "Could not read file."); }
            }} /></label>
            {payloadError && <p className="error" role="alert">{payloadError}</p>}
            <div className="divider" />
            <div className={model?.seal ? "seal-callout armed" : "seal-callout"}>
              <span className="field-label">Encryption</span>
              <p>{model?.seal
                ? "Payload is sealed with AES-256-GCM. Receivers need the passphrase."
                : "Unencrypted. Anyone with a view of this screen can read the payload."}</p>
              <input
                type="password" placeholder="Shared passphrase" value={passphrase}
                autoComplete="off" spellCheck={false}
                onChange={(event) => setPassphrase(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") applyPassphrase(passphrase); }}
              />
              <div className="seal-actions">
                <button className="calibration-button" disabled={sealing || !passphrase || !model} onClick={() => applyPassphrase(passphrase)}>
                  {sealing ? "Deriving key…" : model?.seal ? "Re-seal payload" : "Encrypt payload"}
                </button>
                {model?.seal && <button className="text-button" disabled={sealing} onClick={() => { setPassphrase(""); applyPassphrase(""); }}>Remove</button>}
              </div>
              {model?.seal
                ? <p className="hint">Key derived with PBKDF2-SHA256, {model.seal.iterations.toLocaleString()} iterations. Share the phrase out of band — spoken aloud, not over the same channel.</p>
                : <p className="hint">A room of receivers can share one phrase. Everyone holding it can decrypt, now or from a recording.</p>}
            </div>
            <div className="divider" />
            <div className="calibration-callout">
              <span className="field-label">Device calibration</span>
              <p>Cycle through five profiles while the iPhone receiver scores each one.</p>
              <button className="calibration-button" disabled={calibrating} onClick={startCalibration}>{calibrating ? "Calibration running…" : "Run calibration sweep"}</button>
              {calibrating && <div className="mini-progress"><i style={{ width: `${calibrationStatus.progress * 100}%` }} /></div>}
            </div>
            <div className="divider" />
            <span className="field-label">Performance preset</span>
            <div className="preset-grid">{PRESETS.map((preset) => <button key={preset.name} className={chunkSize === preset.blockSize && targetFps === preset.fps ? "selected" : ""} onClick={() => applyPreset(preset)}><strong>{preset.name}</strong><span>{preset.blockSize} B · {preset.fps} fps</span></button>)}</div>
            <label className="field"><span>Data per frame <b>{chunkSize} bytes</b></span><input type="range" min="400" max="2800" step="20" value={chunkSize} onChange={(event) => {
              const next = Number(event.target.value);
              if (model) {
                const issue = payloadIssue(model.bytes, next, Boolean(sealPassphrase));
                if (issue) { setPayloadError(`Frame size not changed. ${issue}`); return; }
              }
              setChunkSize(next);
              if (model) void buildPayload(model.bytes, model.name, next);
            }} /></label>
            <label className="field"><span>Target rate <b>{targetFps} fps</b></span><input type="range" min="4" max="60" value={targetFps} onChange={(event) => setTargetFps(Number(event.target.value))} /></label>
            <p className="hint">Balanced is the best starting point. Try Aggressive after a clean verified transfer.</p>
          </div>

          <div className="panel transmitter">
            <div className="transmit-head"><div><span className="kicker">{calibrating ? "Calibration sweep" : model?.seal ? "Transmitting · sealed" : "Transmitting"}</span><h2>{calibrating ? SWEEP_PROFILES[calibrationStatus.profile].name : model?.name ?? "Preparing data…"}</h2></div><span className={sending || calibrating ? "live active" : "live"}><i />{calibrating ? "TEST" : sending ? "LIVE" : "PAUSED"}</span></div>
            {!calibrating && model && <p className="digest">SHA-256 {model.digest}{model.seal ? " · sealed" : " · cleartext"}</p>}
            <div className="qr-stage"><canvas ref={qrCanvas} /><div className="corner tl"/><div className="corner tr"/><div className="corner bl"/><div className="corner br"/></div>
            <div className="progress-row"><span>{calibrating ? `Profile ${calibrationStatus.profile + 1} / ${SWEEP_PROFILES.length}` : `Frame ${sendIndex + 1} · ${model ? Math.ceil(model.transmit.length / model.blockLen) : 0} source blocks`}</span><span>{calibrating ? `${Math.round(calibrationStatus.progress * 100)}%` : model ? formatBytes(model.bytes.length) : "—"}</span></div>
            <button className="primary" disabled={calibrating} onClick={() => setSending((value) => !value)}>{calibrating ? "Testing receiver…" : sending ? "Pause transmission" : "Start transmission"}</button>
            <div className="metrics-grid">
              <Metric value={displayFps ? displayFps.toFixed(1) : "—"} label="actual display fps" />
              <Metric value={formatBytes(theoretical) + "/s"} label="payload ceiling" />
              <Metric value={String(model ? Math.ceil(model.transmit.length / model.blockLen) : 0)} label="source blocks" />
            </div>
          </div>
        </section>
      ) : (
        <section className="workspace receiver">
          <div className="panel camera-panel">
            <div className="panel-heading"><span>02</span><div><h2>Scan transmission</h2><p>Fill the highlighted square with the transmitting QR code.</p></div></div>
            <div className="camera-stage">
              <video ref={video} playsInline muted />
              <canvas ref={scanCanvas} aria-hidden="true" />
              <div className="scan-frame"><i/><i/><i/><i/></div>
              {cameraState !== "running" && <div className="camera-empty"><span className="aperture">◎</span><p>{cameraState === "starting" ? "Starting camera…" : "Camera is off"}</p></div>}
            </div>
            {cameraInfo && <p className="camera-info">{cameraInfo}</p>}
            {cameraState === "running" ? <button className="secondary full" onClick={stopCamera}>Stop camera</button> : <button className="primary" onClick={startCamera}>Start rear camera</button>}
            {cameraError && <p className="error">{cameraError}. Camera access requires HTTPS on iPhone.</p>}
          </div>

          <div className="panel results">
            {calibrationResults.length > 0 && receiveStats.total === 0 ? <>
              <div className="result-top"><span className="kicker">Calibration results</span><strong>{calibrationResults.length}/{SWEEP_PROFILES.length}</strong></div>
              <p className="result-explainer">{calibrationComplete ? "Sweep complete. Unreadable profiles are recorded as zero." : "Keep the camera aimed at the QR code until the completion beacon arrives."}</p>
              {recommended && <div className={calibrationComplete ? "recommendation final" : "recommendation"}>
                <span>★</span>
                <div>
                  <strong>{calibrationComplete ? "Best setting for this setup" : "Current leader"}</strong>
                  <b>{recommended.blockSize} bytes · {recommended.fps} fps</b>
                  <p>{recommended.name} measured {formatBytes(recommended.unique * recommended.blockSize / (recommended.duration / 1000))}/s useful throughput.</p>
                </div>
              </div>}
              <div className="calibration-results">
                {calibrationResults.map((result) => {
                  const seconds = result.duration / 1000;
                  const expected = Math.round(result.fps * seconds);
                  const capture = Math.min(1, result.unique / expected);
                  const goodput = result.unique * result.blockSize / seconds;
                  return <div className={recommended?.profile === result.profile ? "calibration-result recommended" : "calibration-result"} key={result.profile}>
                    <div><strong>{result.name}</strong><span>{result.blockSize} B · {result.fps} fps</span></div>
                    <div><strong>{formatBytes(goodput)}/s</strong><span>{Math.round(capture * 100)}% capture</span></div>
                  </div>;
                })}
              </div>
              {calibrationComplete && <p className="handoff-copy">Set these two values on the transmitter, then arm this receiver for the file transfer.</p>}
              <button className={calibrationComplete ? "primary" : "text-button"} onClick={resetReceiver}>{calibrationComplete ? "Start data receiver" : "Clear calibration results"}</button>
            </> : <>
              <div className="result-top"><span className="kicker">Recovery progress</span><strong>{Math.round(progress * 100)}%</strong></div>
              <div className="big-progress"><i style={{ width: `${progress * 100}%` }} /></div>
              <div className="metrics-grid receive-metrics">
                <Metric value={`${receiveStats.rank} / ${receiveStats.total || "—"}`} label="fountain frames" />
                <Metric value={formatBytes(throughput) + "/s"} label="effective throughput" />
                <Metric value={receiveStats.elapsed ? receiveStats.elapsed.toFixed(1) + "s" : "—"} label="elapsed time" />
                <Metric value={receiveStats.scans ? String(receiveStats.scans - receiveStats.unique) : "—"} label="duplicate reads" />
              </div>
              {sealedRaw && unsealState !== "open" && <div className="unlock-panel">
                <span className="field-label">Sealed transfer</span>
                <p>{formatBytes(sealedRaw.length)} of ciphertext recovered. Enter the sender&apos;s passphrase to open it.</p>
                <input
                  type="password" placeholder="Shared passphrase" value={receivePassphrase}
                  autoComplete="off" spellCheck={false}
                  onChange={(event) => setReceivePassphrase(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void attemptUnseal(); }}
                />
                <button className="primary" disabled={unsealState === "working" || !receivePassphrase} onClick={() => void attemptUnseal()}>
                  {unsealState === "working" ? "Deriving key…" : "Unlock payload"}
                </button>
                {unsealState === "failed" && <p className="error">Could not open. The passphrase is wrong, or the payload was altered in transit — these are indistinguishable.</p>}
              </div>}
              <div className={`verification ${verified === true ? "good" : verified === false ? "bad" : ""}`}>
                <span>{verified === true ? "✓" : verified === false ? "!" : "…"}</span>
                <div>
                  <strong>{verified === true ? (unsealState === "open" ? "Decrypted and authenticated" : "Reassembled") : verified === false ? (unsealState === "failed" ? "Could not decrypt" : "Checksum mismatch") : sealedRaw ? "Sealed — passphrase required" : "Collecting fountain frames"}</strong>
                  <p>{verified === true
                    ? (unsealState === "open"
                      ? "The GCM tag verified: these bytes are exactly what the sender sealed."
                      : "Bytes reassembled intact. This transfer was unencrypted, so it is not authenticated — compare the digest out of band.")
                    : "Any new fountain frame can advance recovery."}</p>
                </div>
              </div>
              {receivedDigest && <p className="digest">SHA-256 {receivedDigest}</p>}
              {completeData && <button className="secondary full" onClick={() => { const url = URL.createObjectURL(new Blob([new Uint8Array(completeData)])); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "airgap-received.bin"; anchor.click(); URL.revokeObjectURL(url); }}>Download received file</button>}
              <button className="text-button" onClick={resetReceiver}>Reset receiver statistics</button>
            </>}
          </div>
        </section>
      )}

      <footer><span>Everything runs locally in this browser.</span><span>60 fps camera → ZXing WASM workers → binary LT recovery → checksum</span></footer>
    </main>
  );
}
