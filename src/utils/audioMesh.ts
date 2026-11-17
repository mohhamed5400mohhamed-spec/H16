// WebRTC Group Voice Mesh Manager for Real-Time Multi-User Audio (Speakers + Listeners)

import { Socket } from 'socket.io-client';

// Global dynamic TURN/STUN configuration for bypassing firewalls & VoIP blocks in countries with strict NATs
const customTurnUrl = (typeof window !== 'undefined' && (window as any).__CHATHASSAN_TURN_URL__) || import.meta.env.VITE_TURN_SERVER_URL;
const customTurnUser = (typeof window !== 'undefined' && (window as any).__CHATHASSAN_TURN_USER__) || import.meta.env.VITE_TURN_USERNAME;
const customTurnPass = (typeof window !== 'undefined' && (window as any).__CHATHASSAN_TURN_PASS__) || import.meta.env.VITE_TURN_CREDENTIAL;

const defaultTurnServers: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  {
    // TURN over TLS on Port 443 (HTTPS port) - Bypasses DPI & ISP VoIP blocking in UAE, Oman, Qatar, KSA, etc.
    urls: [
      'turns:openrelay.metered.ca:443?transport=tcp',
      'turn:openrelay.metered.ca:443?transport=tcp',
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

if (customTurnUrl) {
  defaultTurnServers.unshift({
    urls: String(customTurnUrl).split(',').map((u) => u.trim()).filter(Boolean),
    username: customTurnUser || undefined,
    credential: customTurnPass || undefined
  });
}

export const ICE_SERVERS: RTCConfiguration = {
  iceServers: defaultTurnServers,
  iceCandidatePoolSize: 10,
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

let runtimeIceFetched = false;
let runtimeIceFetchPromise: Promise<void> | null = null;

export function getRuntimeIceServers(): RTCConfiguration {
  return {
    ...ICE_SERVERS,
    iceServers: [...(ICE_SERVERS.iceServers || defaultTurnServers)]
  };
}

export async function refreshIceServersFromApi(): Promise<void> {
  if (runtimeIceFetched || typeof window === 'undefined') return;
  if (runtimeIceFetchPromise) return runtimeIceFetchPromise;
  runtimeIceFetchPromise = (async () => {
    try {
      const apiBase = ((import.meta.env.VITE_SERVER_URL as string) || '').replace(/\/$/, '');
      const res = await fetch(`${apiBase}/api/ice-servers`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data?.iceServers) && data.iceServers.length > 0) {
        ICE_SERVERS.iceServers = data.iceServers;
        runtimeIceFetched = true;
      }
    } catch {
      // Keep default STUN/TURN list on transient offline error
    } finally {
      runtimeIceFetchPromise = null;
    }
  })();
  return runtimeIceFetchPromise;
}

/**
 * Enforces Opus codec parameters for weak internet & mobile 3G/4G/5G connections:
 * - usedtx=1: Discontinuous Transmission (0 data sent when silent)
 * - useinbandfec=1: Forward Error Correction (reconstructs dropped audio packets without retransmitting)
 * - maxaveragebitrate=24000: Caps bitrate at 24kbps (~3KB/sec) to prevent lag and bufferbloat on slow connections
 */
export function optimizeSdpForWeakNetworks(sdp: string): string {
  if (!sdp) return sdp;
  return sdp
    .replace(/a=fmtp:111 ((?:(?!usedtx=1).)*)\r\n/g, 'a=fmtp:111 $1;useinbandfec=1;usedtx=1;maxaveragebitrate=24000;stereo=0\r\n')
    .replace(/a=fmtp:96 ((?:(?!usedtx=1).)*)\r\n/g, 'a=fmtp:96 $1;useinbandfec=1;usedtx=1;maxaveragebitrate=24000;stereo=0\r\n');
}

export interface RemoteVoicePeer {
  id: string;
  username: string;
  pc: RTCPeerConnection;
  stream?: MediaStream;
  audioElement?: HTMLAudioElement;
  isMuted?: boolean;
  isSpeaking?: boolean;
  isRemoteSpeaker?: boolean;
  isInitiator?: boolean;
  iceRestartAttempts?: number;
}

// Encode Float32 PCM samples (at sourceSampleRate) downsampled to 16kHz Int16 mono WAV base64
export function encodeDownsampledWavBase64(samples: Float32Array, sourceSampleRate: number): string {
  const targetRate = 16000;
  const ratio = sourceSampleRate / targetRate;
  const newLength = Math.max(1, Math.floor(samples.length / ratio));
  const dataSize = newLength * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < newLength; i++) {
    const srcIdx = Math.min(samples.length - 1, Math.floor(i * ratio));
    const s = Math.max(-1, Math.min(1, samples[srcIdx]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return 'data:audio/wav;base64,' + btoa(binary);
}

export class AudioMeshManager {
  private socket: Socket;
  public localStream: MediaStream | null = null;
  public peers: Map<string, RemoteVoicePeer> = new Map();
  private pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
  private activeRoomSpeakers: Set<string> = new Set();
  private fallbackTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private disconnectRecoveryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private lastFallbackRequestAt: Map<string, number> = new Map();
  private voiceWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  public isMuted = false;
  public isDeafened = false;
  public isInVoice = false; // True when user is holding a mic
  public isListening = true; // True whenever user is inside a chat room
  public autoplayBlocked = false;

  private audioCtx: AudioContext | null = null;
  private playbackCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animFrameId: number | null = null;
  private lastSpeakingState = false;

  // On-demand PCM-WAV fallback streaming (only active if a listener requests fallback due to firewall/NAT block)
  private pcmProcessor: ScriptProcessorNode | null = null;
  private pcmSource: MediaStreamAudioSourceNode | null = null;
  private pcmSilentGain: GainNode | null = null;
  private pcmBuffer: Float32Array[] = [];
  private pcmTotalSamples = 0;
  private isFallbackStreaming = false;
  private nextFallbackPlayTime: Map<string, number> = new Map();

  private audioContainerEl: HTMLElement | null = null;
  private gestureUnlockAttached = false;

  // Callbacks
  public onVolumeChange?: (volume: number) => void;
  public onPeersUpdated?: (peers: RemoteVoicePeer[]) => void;
  public onError?: (errorMsg: string) => void;
  public onAutoplayBlocked?: (blocked: boolean) => void;

  private socketListeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];

  constructor(socket: Socket) {
    this.socket = socket;
    this.ensureAudioContainer();
    this.attachGestureUnlock();
    this.setupSocketListeners();
    refreshIceServersFromApi().catch(() => {});
    this.startVoiceWatchdog();
  }

  private startVoiceWatchdog() {
    if (this.voiceWatchdogTimer) return;
    this.voiceWatchdogTimer = setInterval(() => {
      if (this.activeRoomSpeakers.size === 0) return;
      const now = Date.now();
      for (const speakerId of this.activeRoomSpeakers) {
        if (speakerId === this.socket.id) continue;
        if (!this.hasConnectedPeer(speakerId)) {
          const lastReq = this.lastFallbackRequestAt.get(speakerId) || 0;
          if (now - lastReq >= 3500) {
            this.lastFallbackRequestAt.set(speakerId, now);
            this.socket.emit('requestVoiceFallback', { speakerId });
          }
        }
      }
    }, 4000);
  }

  private requestFallbackForSpeaker(speakerId: string) {
    const now = Date.now();
    const lastReq = this.lastFallbackRequestAt.get(speakerId) || 0;
    if (now - lastReq < 3200) return;
    this.lastFallbackRequestAt.set(speakerId, now);
    this.socket.emit('requestVoiceFallback', { speakerId });
  }

  private ensureAudioContainer() {
    if (typeof document === 'undefined') return;
    let container = document.getElementById('hassan-webrtc-audio-pool');
    if (!container) {
      container = document.createElement('div');
      container.id = 'hassan-webrtc-audio-pool';
      container.style.position = 'fixed';
      container.style.width = '1px';
      container.style.height = '1px';
      container.style.opacity = '0';
      container.style.pointerEvents = 'none';
      container.style.overflow = 'hidden';
      document.body.appendChild(container);
    }
    this.audioContainerEl = container;
  }

  private attachGestureUnlock() {
    if (this.gestureUnlockAttached || typeof window === 'undefined') return;
    this.gestureUnlockAttached = true;
    const unlock = () => {
      if (this.autoplayBlocked || (this.playbackCtx && this.playbackCtx.state === 'suspended')) {
        this.unlockAudioPlayback();
      }
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('touchstart', unlock, { passive: true });
    window.addEventListener('click', unlock, { passive: true });
  }

  public async unlockAudioPlayback(): Promise<void> {
    if (this.playbackCtx && this.playbackCtx.state === 'suspended') {
      try {
        await this.playbackCtx.resume();
      } catch {}
    }
    let stillBlocked = false;
    for (const peer of this.peers.values()) {
      if (peer.audioElement) {
        peer.audioElement.muted = this.isDeafened;
        if (peer.audioElement.paused && peer.stream) {
          try {
            await peer.audioElement.play();
          } catch {
            stillBlocked = true;
          }
        }
      }
    }
    this.autoplayBlocked = stillBlocked;
    if (this.onAutoplayBlocked) {
      this.onAutoplayBlocked(stillBlocked);
    }
  }

  private registerSocketListener(event: string, fn: (...args: any[]) => void) {
    this.socket.on(event, fn);
    this.socketListeners.push({ event, fn });
  }

  private setupSocketListeners() {
    // When local user takes a mic, server sends ALL room peers (speakers & listeners) to initiate offers to
    this.registerSocketListener('voiceRoomUsers', (existingUsers: Array<{ id: string; username: string; isVoice?: boolean }>) => {
      if (!this.isInVoice || !this.localStream) return;
      existingUsers.forEach((user) => {
        if (user.id && user.id !== this.socket.id) {
          if (user.isVoice) this.activeRoomSpeakers.add(user.id);
          this.initiateCallTo(user.id, user.username, Boolean(user.isVoice));
        }
      });
    });

    // When a new user enters the room while we are on a mic, initiate an offer to them so they hear us!
    this.registerSocketListener('voiceNewListener', (listener: { id: string; username: string }) => {
      if (!this.isInVoice || !this.localStream) return;
      if (listener.id && listener.id !== this.socket.id) {
        this.initiateCallTo(listener.id, listener.username, false);
      }
    });

    // When another user joins voice/mic
    this.registerSocketListener('userJoinedVoice', (user: { id: string; username: string }) => {
      if (user?.id && user.id !== this.socket.id) {
        this.activeRoomSpeakers.add(user.id);
        this.scheduleFallbackCheck(user.id);
      }
    });

    // When listener joins room, track active speakers so we know if WebRTC fails and needs fallback
    this.registerSocketListener('micSlotsUpdated', (slots: Array<{ slotNumber: number; user: { id: string; username: string } | null }>) => {
      const currentSpeakers = new Set<string>();
      (slots || []).forEach((slot) => {
        if (slot.user?.id && slot.user.id !== this.socket.id) {
          currentSpeakers.add(slot.user.id);
          if (!this.activeRoomSpeakers.has(slot.user.id)) {
            this.scheduleFallbackCheck(slot.user.id);
          }
        }
      });
      this.activeRoomSpeakers = currentSpeakers;
      // Clean up fallback timers for users no longer on mic
      for (const [uid, t] of this.fallbackTimers.entries()) {
        if (!currentSpeakers.has(uid)) {
          clearTimeout(t);
          this.fallbackTimers.delete(uid);
        }
      }
    });

    // Server instructs this speaker to stream PCM-WAV fallback chunks because a listener couldn't connect via WebRTC
    this.registerSocketListener('enableVoiceFallback', () => {
      if (this.isInVoice && this.localStream && !this.isFallbackStreaming) {
        this.startPcmFallbackStreaming();
      }
    });

    // Signaling Relay: incoming offer, answer, or ice candidate (Works for BOTH Speakers AND Listeners!)
    this.registerSocketListener('voiceSignal', async ({ senderId, senderUsername, signal }: { senderId: string; senderUsername: string; signal: any }) => {
      if (!this.isListening && !this.isInVoice) return;
      if (!senderId || senderId === this.socket.id) return;

      try {
        if (signal.type === 'offer') {
          await this.handleReceiveOffer(senderId, senderUsername, signal);
        } else if (signal.type === 'answer') {
          await this.handleReceiveAnswer(senderId, signal);
        } else if (signal.candidate) {
          await this.handleReceiveCandidate(senderId, signal.candidate);
        }
      } catch (err: any) {
        console.warn('Signal handling notice:', err?.message || err);
      }
    });

    // Remote user changed voice state (e.g. muted or speaking)
    this.registerSocketListener('userVoiceStateChanged', ({ userId, isMuted, isSpeaking }: { userId: string; isMuted: boolean; isSpeaking: boolean }) => {
      const peer = this.peers.get(userId);
      if (peer) {
        if (typeof isMuted === 'boolean') peer.isMuted = isMuted;
        if (typeof isSpeaking === 'boolean') peer.isSpeaking = isSpeaking;
        this.notifyPeers();
      }
    });

    // Remote user left voice / dropped mic
    this.registerSocketListener('userLeftVoice', ({ userId }: { userId: string }) => {
      this.activeRoomSpeakers.delete(userId);
      const t = this.fallbackTimers.get(userId);
      if (t) {
        clearTimeout(t);
        this.fallbackTimers.delete(userId);
      }
      if (!this.isInVoice) {
        this.closePeer(userId);
      } else {
        const peer = this.peers.get(userId);
        if (peer) {
          peer.isRemoteSpeaker = false;
          if (peer.audioElement) {
            peer.audioElement.pause();
            peer.audioElement.srcObject = null;
          }
          peer.stream = undefined;
          this.notifyPeers();
        }
      }
    });
  }

  private scheduleFallbackCheck(speakerId: string) {
    if (this.fallbackTimers.has(speakerId)) {
      clearTimeout(this.fallbackTimers.get(speakerId)!);
    }
    const timer = setTimeout(() => {
      this.fallbackTimers.delete(speakerId);
      if (!this.activeRoomSpeakers.has(speakerId)) return;
      if (!this.hasConnectedPeer(speakerId)) {
        this.requestFallbackForSpeaker(speakerId);
      }
    }, 2800);
    this.fallbackTimers.set(speakerId, timer);
  }

  // Called when entering or leaving rooms so listener state stays clean
  public resetForRoomSwitch() {
    this.pendingCandidates.clear();
    this.activeRoomSpeakers.clear();
    this.nextFallbackPlayTime.clear();
    this.lastFallbackRequestAt.clear();
    for (const t of this.fallbackTimers.values()) clearTimeout(t);
    this.fallbackTimers.clear();
    for (const t of this.disconnectRecoveryTimers.values()) clearTimeout(t);
    this.disconnectRecoveryTimers.clear();

    if (this.isInVoice) {
      this.leaveVoice();
    } else {
      this.peers.forEach((peer) => {
        if (peer.audioElement) {
          peer.audioElement.pause();
          peer.audioElement.srcObject = null;
          peer.audioElement.remove();
        }
        peer.pc.close();
      });
      this.peers.clear();
      this.notifyPeers();
    }
    this.isListening = true;
  }

  // Join the voice call (Mic Holder)
  public async joinVoice(): Promise<boolean> {
    if (this.isInVoice && this.localStream) return true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      this.localStream = stream;
      this.isInVoice = true;
      this.isListening = true;
      this.isMuted = false;

      // Setup Audio Visualizer and Speech Detection
      this.setupAudioAnalysis(stream);

      // Unlock playback context simultaneously inside user gesture
      this.unlockAudioPlayback().catch(() => {});

      this.socket.emit('joinVoice');
      return true;
    } catch (err: any) {
      console.warn('Microphone permission not granted or device unavailable:', err?.message || err);
      const msg = err.name === 'NotAllowedError'
        ? 'تم رفض إذن الوصول للميكروفون. يرجى تفعيل إذن المايك في إعدادات المتصفح.'
        : 'تعذر الوصول إلى الميكروفون: ' + (err.message || 'يرجى التأكد من توصيل المايكروفون');
      if (this.onError) this.onError(msg);
      return false;
    }
  }

  // Take one of the 5 Mic Slots
  public async takeMicSlot(slotNumber: number): Promise<boolean> {
    const success = await this.joinVoice();
    if (success) {
      this.socket.emit('takeMic', { slotNumber });
      return true;
    }
    return false;
  }

  // Drop Mic Slot
  public dropMicSlot() {
    this.socket.emit('dropMic');
    this.leaveVoice();
  }

  private createPeerConnection(targetId: string, username: string, isRemoteSpeaker = false, isInitiator = false): RemoteVoicePeer {
    const existing = this.peers.get(targetId);
    if (existing) {
      try {
        existing.pc.ontrack = null;
        existing.pc.onicecandidate = null;
        existing.pc.oniceconnectionstatechange = null;
        existing.pc.close();
      } catch {}
      if (existing.audioElement) {
        existing.audioElement.pause();
        existing.audioElement.srcObject = null;
        existing.audioElement.remove();
      }
      this.peers.delete(targetId);
    }

    const existingDiscTimer = this.disconnectRecoveryTimers.get(targetId);
    if (existingDiscTimer) {
      clearTimeout(existingDiscTimer);
      this.disconnectRecoveryTimers.delete(targetId);
    }

    const pc = new RTCPeerConnection(getRuntimeIceServers());
    const peer: RemoteVoicePeer = {
      id: targetId,
      username,
      pc,
      isRemoteSpeaker,
      isInitiator,
      iceRestartAttempts: 0
    };
    this.peers.set(targetId, peer);

    pc.ontrack = (event) => {
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      this.attachRemoteTrack(peer, stream);
      const t = this.fallbackTimers.get(targetId);
      if (t) {
        clearTimeout(t);
        this.fallbackTimers.delete(targetId);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('voiceSignal', {
          targetId,
          signal: { candidate: event.candidate }
        });
      }
    };

    const handleConnectionState = () => {
      const iceState = pc.iceConnectionState;
      const connState = pc.connectionState;
      const currentPeer = this.peers.get(targetId);
      if (!currentPeer || currentPeer.pc !== pc) return;

      if (iceState === 'connected' || iceState === 'completed' || connState === 'connected') {
        peer.iceRestartAttempts = 0;
        const dt = this.disconnectRecoveryTimers.get(targetId);
        if (dt) {
          clearTimeout(dt);
          this.disconnectRecoveryTimers.delete(targetId);
        }
        const t = this.fallbackTimers.get(targetId);
        if (t) {
          clearTimeout(t);
          this.fallbackTimers.delete(targetId);
        }
        this.notifyPeers();
      } else if (iceState === 'disconnected' || connState === 'disconnected') {
        // VPN toggle / mobile handoff often stays stuck in 'disconnected' without emitting 'failed'
        if (!this.disconnectRecoveryTimers.has(targetId)) {
          const dt = setTimeout(async () => {
            this.disconnectRecoveryTimers.delete(targetId);
            const latest = this.peers.get(targetId);
            if (!latest || latest.pc !== pc) return;
            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return;

            if (this.activeRoomSpeakers.has(targetId)) {
              this.requestFallbackForSpeaker(targetId);
            }
            if (this.isInVoice && peer.isInitiator && (peer.iceRestartAttempts || 0) < 2) {
              peer.iceRestartAttempts = (peer.iceRestartAttempts || 0) + 1;
              try {
                let offer = await pc.createOffer({ iceRestart: true });
                if (offer.sdp) {
                  offer = { type: offer.type, sdp: optimizeSdpForWeakNetworks(offer.sdp) };
                }
                await pc.setLocalDescription(offer);
                this.socket.emit('voiceSignal', { targetId, signal: offer });
              } catch {}
            }
          }, 1800);
          this.disconnectRecoveryTimers.set(targetId, dt);
        }
      } else if (iceState === 'failed' || connState === 'failed') {
        if (this.activeRoomSpeakers.has(targetId)) {
          this.requestFallbackForSpeaker(targetId);
        }
        if (this.isInVoice && peer.isInitiator && (peer.iceRestartAttempts || 0) < 2) {
          peer.iceRestartAttempts = (peer.iceRestartAttempts || 0) + 1;
          pc.createOffer({ iceRestart: true })
            .then(async (rawOffer) => {
              const offer = rawOffer.sdp
                ? { type: rawOffer.type, sdp: optimizeSdpForWeakNetworks(rawOffer.sdp) }
                : rawOffer;
              await pc.setLocalDescription(offer);
              this.socket.emit('voiceSignal', { targetId, signal: offer });
            })
            .catch(() => {});
        }
      }
    };

    pc.oniceconnectionstatechange = handleConnectionState;
    pc.onconnectionstatechange = handleConnectionState;

    return peer;
  }

  // Initiate call to an existing peer (or cleanly upgrade existing recvonly connection on mic re-climb)
  private async initiateCallTo(targetId: string, username: string, isRemoteSpeaker = false) {
    if (!this.localStream) return;

    const existing = this.peers.get(targetId);
    if (existing && existing.pc && existing.pc.signalingState === 'stable') {
      const hasLiveSender = existing.pc.getSenders().some((s) => s.track && s.track.readyState === 'live');
      if (hasLiveSender) return;

      // Upgrade existing recvonly connection cleanly using existing audio sender/transceiver
      try {
        existing.isInitiator = true;
        if (isRemoteSpeaker) existing.isRemoteSpeaker = true;
        const audioTrack = this.localStream.getAudioTracks()[0];
        if (audioTrack) {
          const audioTransceiver = existing.pc.getTransceivers().find(
            (tr) => tr.receiver?.track?.kind === 'audio' || tr.sender?.track?.kind === 'audio' || tr.sender
          );
          if (audioTransceiver) {
            audioTransceiver.direction = 'sendrecv';
            await audioTransceiver.sender.replaceTrack(audioTrack);
          } else {
            existing.pc.addTrack(audioTrack, this.localStream);
          }
        }
        let offer = await existing.pc.createOffer();
        if (offer.sdp) {
          offer = { type: offer.type, sdp: optimizeSdpForWeakNetworks(offer.sdp) };
        }
        await existing.pc.setLocalDescription(offer);
        this.socket.emit('voiceSignal', { targetId, signal: offer });
        this.notifyPeers();
        return;
      } catch (err) {
        console.warn('Renegotiation failed, creating fresh peer connection:', err);
      }
    }

    const peer = this.createPeerConnection(targetId, username, isRemoteSpeaker, true);
    const pc = peer.pc;

    // Add local tracks
    this.localStream.getTracks().forEach((track) => {
      pc.addTrack(track, this.localStream!);
    });

    // Create & send offer optimized for weak mobile networks
    try {
      let offer = await pc.createOffer();
      if (offer.sdp) {
        offer = { type: offer.type, sdp: optimizeSdpForWeakNetworks(offer.sdp) };
      }
      await pc.setLocalDescription(offer);
      this.socket.emit('voiceSignal', {
        targetId,
        signal: offer
      });
    } catch (err) {
      console.error('Failed to create offer:', err);
    }

    this.notifyPeers();
  }

  // Handle incoming offer from a speaker peer (works for BOTH listeners and speakers!)
  private async handleReceiveOffer(senderId: string, senderUsername: string, offer: RTCSessionDescriptionInit) {
    let peer = this.peers.get(senderId);

    // If there is a glare (both created offers) or unstable state, recreate cleanly when receiving an authoritative speaker offer
    if (!peer || peer.pc.signalingState === 'have-local-offer') {
      peer = this.createPeerConnection(senderId, senderUsername, true, false);
      if (this.isInVoice && this.localStream) {
        this.localStream.getTracks().forEach((track) => {
          peer!.pc.addTrack(track, this.localStream!);
        });
      }
    } else {
      peer.isRemoteSpeaker = true;
    }

    const pc = peer.pc;
    await pc.setRemoteDescription(new RTCSessionDescription(offer));

    // Flush any queued ICE candidates that arrived before remote description
    const queued = this.pendingCandidates.get(senderId);
    if (queued && queued.length > 0) {
      for (const cand of queued) {
        await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
      }
      this.pendingCandidates.delete(senderId);
    }

    // If we are listening only and haven't added tracks, ensure recvonly transceiver is ready
    if (!this.isInVoice && pc.getTransceivers().length === 0) {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    let answer = await pc.createAnswer();
    if (answer.sdp) {
      answer = { type: answer.type, sdp: optimizeSdpForWeakNetworks(answer.sdp) };
    }
    await pc.setLocalDescription(answer);

    this.socket.emit('voiceSignal', {
      targetId: senderId,
      signal: answer
    });

    this.notifyPeers();
  }

  // Handle incoming answer
  private async handleReceiveAnswer(senderId: string, answer: RTCSessionDescriptionInit) {
    const peer = this.peers.get(senderId);
    if (peer && peer.pc && peer.pc.signalingState === 'have-local-offer') {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
      const queued = this.pendingCandidates.get(senderId);
      if (queued && queued.length > 0) {
        for (const cand of queued) {
          await peer.pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        }
        this.pendingCandidates.delete(senderId);
      }
    }
  }

  // Handle incoming candidate with automatic queueing before setRemoteDescription
  private async handleReceiveCandidate(senderId: string, candidate: RTCIceCandidateInit) {
    const peer = this.peers.get(senderId);
    if (peer && peer.pc && peer.pc.remoteDescription) {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    } else {
      const list = this.pendingCandidates.get(senderId) || [];
      list.push(candidate);
      this.pendingCandidates.set(senderId, list);
    }
  }

  // Attach remote stream to DOM-mounted HTMLAudioElement with Autoplay-block notification
  private attachRemoteTrack(peer: RemoteVoicePeer, stream: MediaStream) {
    this.ensureAudioContainer();
    peer.stream = stream;
    let audio = peer.audioElement;
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', 'true');
      audio.setAttribute('webkit-playsinline', 'true');
      (audio as any).playsInline = true;
      audio.volume = 1.0;
      audio.muted = this.isDeafened;
      peer.audioElement = audio;
      if (this.audioContainerEl) {
        this.audioContainerEl.appendChild(audio);
      }
    }
    audio.srcObject = stream;
    audio.muted = this.isDeafened;
    audio
      .play()
      .then(() => {
        if (this.autoplayBlocked) {
          this.autoplayBlocked = false;
          this.onAutoplayBlocked?.(false);
        }
      })
      .catch(() => {
        this.autoplayBlocked = true;
        this.onAutoplayBlocked?.(true);
      });
    this.notifyPeers();
  }

  // On-demand seamless PCM-WAV fallback streamer (when a listener's firewall blocks WebRTC/TURN)
  private startPcmFallbackStreaming() {
    if (!this.localStream || !this.isInVoice || this.isFallbackStreaming) return;
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = this.audioCtx && this.audioCtx.state !== 'closed' ? this.audioCtx : new AudioCtx();
      this.audioCtx = ctx;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      const source = ctx.createMediaStreamSource(this.localStream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;

      this.pcmSource = source;
      this.pcmProcessor = processor;
      this.pcmSilentGain = silentGain;
      this.pcmBuffer = [];
      this.pcmTotalSamples = 0;
      this.isFallbackStreaming = true;

      const targetChunkSamples = Math.round(ctx.sampleRate * 0.36); // ~360ms standalone WAV chunk

      processor.onaudioprocess = (e) => {
        if (!this.isInVoice || this.isMuted || !this.isFallbackStreaming) return;
        const input = e.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);
        this.pcmBuffer.push(copy);
        this.pcmTotalSamples += copy.length;

        if (this.pcmTotalSamples >= targetChunkSamples) {
          const merged = new Float32Array(this.pcmTotalSamples);
          let pos = 0;
          for (const buf of this.pcmBuffer) {
            merged.set(buf, pos);
            pos += buf.length;
          }
          this.pcmBuffer = [];
          this.pcmTotalSamples = 0;

          // Gate pure silence to save bandwidth
          let maxAmp = 0;
          for (let i = 0; i < merged.length; i += 8) {
            const abs = Math.abs(merged[i]);
            if (abs > maxAmp) maxAmp = abs;
          }
          if (maxAmp > 0.004) {
            const wavDataUri = encodeDownsampledWavBase64(merged, ctx.sampleRate);
            this.socket.emit('voiceDataChunk', { chunk: wavDataUri });
          }
        }
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(ctx.destination);
    } catch (err) {
      console.warn('PCM fallback stream setup notice:', err);
    }
  }

  private stopPcmFallbackStreaming() {
    this.isFallbackStreaming = false;
    this.pcmBuffer = [];
    this.pcmTotalSamples = 0;
    try {
      this.pcmProcessor?.disconnect();
      this.pcmSource?.disconnect();
      this.pcmSilentGain?.disconnect();
    } catch {}
    this.pcmProcessor = null;
    this.pcmSource = null;
    this.pcmSilentGain = null;
  }

  // Play incoming standalone WAV/Audio chunk smoothly via bounded WebAudio jitter buffer
  public async playFallbackChunk(userId: string, chunkDataUri: string): Promise<void> {
    if (this.isDeafened || this.hasConnectedPeer(userId)) return;
    try {
      if (!this.playbackCtx || this.playbackCtx.state === 'closed') {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.playbackCtx = new AudioCtx();
      }
      const ctx = this.playbackCtx;
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => {
          this.autoplayBlocked = true;
          this.onAutoplayBlocked?.(true);
        });
      }
      if (ctx.state !== 'running') {
        this.autoplayBlocked = true;
        this.onAutoplayBlocked?.(true);
        return;
      }

      const b64Index = chunkDataUri.indexOf('base64,');
      if (b64Index === -1) return;
      const binaryStr = atob(chunkDataUri.slice(b64Index + 7));
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const now = ctx.currentTime;
      const prevScheduled = this.nextFallbackPlayTime.get(userId) || now + 0.02;
      // Clamp max jitter buffer drift to 320ms so VPN latency spikes never lag audio seconds behind
      const scheduledAt = Math.min(now + 0.32, Math.max(now + 0.02, prevScheduled));
      source.start(scheduledAt);
      this.nextFallbackPlayTime.set(userId, scheduledAt + audioBuffer.duration);
    } catch {
      // Ignore malformed chunk
    }
  }

  // Setup AnalyserNode for local mic volume meter and speaking indicator
  private setupAudioAnalysis(stream: MediaStream) {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!this.audioCtx || this.audioCtx.state === 'closed') {
        this.audioCtx = new AudioCtx();
      }
      const source = this.audioCtx.createMediaStreamSource(stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.5;
      source.connect(this.analyser);

      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const checkVolume = () => {
        if (!this.analyser || !this.isInVoice) return;

        if (this.isMuted) {
          if (this.lastSpeakingState) {
            this.lastSpeakingState = false;
            this.socket.emit('voiceStateUpdate', { isSpeaking: false });
          }
          if (this.onVolumeChange) {
            this.onVolumeChange(0);
          }
          this.animFrameId = requestAnimationFrame(checkVolume);
          return;
        }

        this.analyser.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const avg = sum / bufferLength;
        const volumePercent = Math.min(100, Math.round((avg / 128) * 100));

        if (this.onVolumeChange) {
          this.onVolumeChange(volumePercent);
        }

        const isSpeakingNow = volumePercent > 12;
        if (isSpeakingNow !== this.lastSpeakingState) {
          this.lastSpeakingState = isSpeakingNow;
          this.socket.emit('voiceStateUpdate', { isSpeaking: isSpeakingNow });
        }

        this.animFrameId = requestAnimationFrame(checkVolume);
      };

      this.animFrameId = requestAnimationFrame(checkVolume);
    } catch (err) {
      console.error('Audio analysis setup error:', err);
    }
  }

  // Toggle local mute
  public toggleMute(): boolean {
    if (!this.localStream) return false;
    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !this.isMuted;
    });

    this.socket.emit('voiceStateUpdate', {
      isMuted: this.isMuted,
      isSpeaking: false
    });

    if (this.onVolumeChange && this.isMuted) {
      this.onVolumeChange(0);
    }

    return this.isMuted;
  }

  // Toggle Deafen (mute all remote voices)
  public toggleDeafen(): boolean {
    this.isDeafened = !this.isDeafened;
    this.peers.forEach((peer) => {
      if (peer.audioElement) {
        peer.audioElement.muted = this.isDeafened;
        if (!this.isDeafened && peer.stream && peer.audioElement.paused) {
          peer.audioElement.play().catch(() => {});
        }
      }
    });
    if (!this.isDeafened) {
      this.unlockAudioPlayback().catch(() => {});
    }
    return this.isDeafened;
  }

  // Close specific peer
  private closePeer(id: string) {
    this.pendingCandidates.delete(id);
    const peer = this.peers.get(id);
    if (peer) {
      if (peer.audioElement) {
        peer.audioElement.pause();
        peer.audioElement.srcObject = null;
        peer.audioElement.remove();
      }
      try {
        peer.pc.close();
      } catch {}
      this.peers.delete(id);
      this.notifyPeers();
    }
  }

  // Leave Voice Mic (keeps listener connections to any remaining room speakers!)
  public leaveVoice() {
    if (!this.isInVoice) return;
    this.isInVoice = false;

    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    this.stopPcmFallbackStreaming();

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }

    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }

    // Remove outgoing mic senders and keep recvonly connections to active speakers; close connections to listeners
    for (const [id, peer] of Array.from(this.peers.entries())) {
      const isSpeaker = peer.isRemoteSpeaker || this.activeRoomSpeakers.has(id);
      if (isSpeaker) {
        try {
          peer.pc.getSenders().forEach((sender) => {
            if (sender.track) {
              sender.replaceTrack(null).catch(() => {});
            }
          });
        } catch {}
      } else {
        this.closePeer(id);
      }
    }

    this.socket.emit('leaveVoice');
    this.notifyPeers();
  }

  // Check if WebRTC connection is already active and streaming with peer to avoid duplicate audio fallback
  public hasConnectedPeer(id: string): boolean {
    const peer = this.peers.get(id);
    if (!peer || !peer.pc) return false;
    const stateOk = peer.pc.connectionState === 'connected' || peer.pc.iceConnectionState === 'connected' || peer.pc.iceConnectionState === 'completed';
    const hasAudioTrack = Boolean(peer.stream && peer.stream.getAudioTracks().some((t) => t.readyState === 'live'));
    return stateOk && hasAudioTrack;
  }

  // Complete cleanup and destroy manager instance
  public destroy() {
    this.isListening = false;
    if (this.voiceWatchdogTimer) {
      clearInterval(this.voiceWatchdogTimer);
      this.voiceWatchdogTimer = null;
    }
    this.leaveVoice();
    this.peers.forEach((peer) => {
      if (peer.audioElement) {
        peer.audioElement.pause();
        peer.audioElement.srcObject = null;
        peer.audioElement.remove();
      }
      try {
        peer.pc.close();
      } catch {}
    });
    this.peers.clear();
    this.pendingCandidates.clear();
    this.lastFallbackRequestAt.clear();
    for (const t of this.fallbackTimers.values()) clearTimeout(t);
    this.fallbackTimers.clear();
    for (const t of this.disconnectRecoveryTimers.values()) clearTimeout(t);
    this.disconnectRecoveryTimers.clear();
    if (this.playbackCtx && this.playbackCtx.state !== 'closed') {
      this.playbackCtx.close().catch(() => {});
      this.playbackCtx = null;
    }
    this.socketListeners.forEach(({ event, fn }) => {
      this.socket.off(event, fn);
    });
    this.socketListeners = [];
    this.onVolumeChange = undefined;
    this.onPeersUpdated = undefined;
    this.onError = undefined;
    this.onAutoplayBlocked = undefined;
  }

  private notifyPeers() {
    if (this.onPeersUpdated) {
      this.onPeersUpdated(Array.from(this.peers.values()));
    }
  }
}
