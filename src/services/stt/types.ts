// kilocode_change - new file: STT service type definitions
import { STTSegment } from "../../shared/sttContract"

/**
 * Interface for providing code glossary context to STT service
 * Implementations capture visible code and format it as a prompt
 */
export interface VisibleCodeGlossary {
	getGlossary(): Promise<string>
}

/**
 * Voice Activity Detection (VAD) configuration
 *
 * Configuration guide:
 * - energyThreshold (0.015 default): Voice detection sensitivity
 *   - Lower = more sensitive (may pick up background noise)
 *   - Higher = less sensitive (may miss quiet speech)
 *   - Typical range: 0.01 - 0.03
 *
 * - shortPauseMs (500ms default): Natural micro-pause detection for commits
 *   - Detects brief pauses between phrases/breaths for interim results
 *   - Too low: commits too frequently, may split words
 *   - Too high: delays interim transcription, buffers grow large
 *   - Typical range: 300-800ms
 *
 * - longPauseMs (2000ms default): Segment boundary for finalization
 *   - Detects end of complete thoughts/sentences
 *   - Should be significantly longer than shortPauseMs (3-5x)
 *   - Typical range: 1500-3000ms
 *
 * - maxChunkMs (10000ms default): Safety cap to prevent unbounded memory
 *   - Only enforced during pauses (never interrupts continuous speech)
 *   - Prevents memory growth during very long utterances
 *   - Typical range: 8000-15000ms
 */
export interface VADConfig {
	/** Energy threshold for voiced frames (0-1 scale) */
	energyThreshold: number

	/** Minimum chunk duration in ms before allowing commit */
	minChunkMs: number

	/** Short pause duration in ms (word gap detection) */
	shortPauseMs: number

	/** Long pause duration in ms (segment finalization) */
	longPauseMs: number

	/** Maximum chunk duration in ms (force commit) */
	maxChunkMs: number

	/** Frame duration in ms (depends on FFmpeg buffer size) */
	frameDurationMs: number

	/** Minimum ratio of voiced frames required to commit (0-1 scale) */
	minVoicedRatio: number
}

/**
 * Default VAD configuration based on OpenAI Realtime API best practices
 * More conservative settings to avoid committing too frequently
 */
export const DEFAULT_VAD_CONFIG: VADConfig = {
	energyThreshold: 0.02, // Voice detection threshold
	minChunkMs: 1000, // Minimum 1 second of audio before allowing commit (prevents tiny fragments)
	shortPauseMs: 300, // 300ms pause for commits (natural breath/word gaps)
	longPauseMs: 2000, // 2 second pause for segment finalization
	maxChunkMs: 10000, // Safety cap at 10 seconds (prevents unbounded memory)
	frameDurationMs: 20, // Typical for 24kHz audio
	minVoicedRatio: 0.3, // Require 30% of frames to have voice activity before committing
}

/**
 * Configuration passed to STT provider
 */
export interface STTProviderConfig {
	apiKey?: string
	language?: string
	prompt?: string // Code glossary/context for better accuracy
	vadConfig?: Partial<VADConfig> // Override VAD configuration
}

/**
 * Callbacks providers use to emit events
 * This is the bridge between provider internals and the WebView event system
 */
export interface STTEventEmitter {
	onStarted: (sessionId: string) => void
	onTranscript: (segments: STTSegment[], isFinal: boolean) => void
	onVolume: (level: number) => void
	onStopped: (reason: "completed" | "cancelled" | "error", text?: string, error?: string) => void
}

/**
 * Internal state tracking for providers
 */
export interface STTSessionState {
	sessionId: string
	isRecording: boolean
	language?: string
}

/**
 * Progressive transcription result
 * Emitted during recording with real-time transcription updates
 */
export interface ProgressiveResult {
	chunkId: number
	text: string
	isInterim: boolean
	confidence: number
	totalDuration: number
	sequenceNumber: number
}

/**
 * Configuration for transcription service
 */
export interface TranscriptionServiceConfig {
	apiKey: string
	language?: string
	prompt?: string // Optional context prompt for code identifiers
}
