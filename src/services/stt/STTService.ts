// kilocode_change - new file: Consolidated STT service - manages OpenAI Realtime transcription lifecycle
import {
	STTProviderConfig,
	STTEventEmitter,
	ProgressiveResult,
	VisibleCodeGlossary,
	VADConfig,
	DEFAULT_VAD_CONFIG,
} from "./types"
import { STTSegment } from "../../shared/sttContract"
import { ProviderSettingsManager } from "../../core/config/ProviderSettingsManager"
import { FFmpegCaptureService } from "./FFmpegCaptureService"
import { OpenAIWhisperClient } from "./OpenAIWhisperClient"

/**
 * Consolidated STT service - manages OpenAI Realtime transcription
 * One instance per ClineProvider (WebView)
 *
 * Coordinates FFmpegCaptureService and OpenAIWhisperClient to provide
 * low-latency streaming transcription via OpenAI Realtime API.
 *
 * Microphone → FFmpeg (PCM16) → FFmpegCaptureService → WebSocket → OpenAI Realtime API
 */
export class STTService {
	private readonly emitter: STTEventEmitter
	private readonly providerSettingsManager: ProviderSettingsManager
	private config: STTProviderConfig | null = null

	// Services
	private audioCapture: FFmpegCaptureService
	private transcriptionClient: OpenAIWhisperClient | null = null

	// Segment-based state (Full State Transfer approach)
	private confirmedSegments: STTSegment[] = [] // All confirmed/polished segments
	private currentPreviewText: string = "" // Current streaming preview text

	// Session state
	private sessionId: string | null = null
	private isActive = false
	private audioDataReceived = false // Track if we've received any audio data

	// Helps ignore late events from previous runs
	private internalSessionId = 0

	// VAD configuration and state
	private vadConfig: VADConfig = DEFAULT_VAD_CONFIG
	private bufferedAudioFrames: Buffer[] = []
	private bufferedAudioMs: number = 0
	private voicedFrameCount: number = 0 // Track frames with voice activity
	private lastVoicedAtMs: number = 0
	private currentEnergy: number = 0

	// Finalization timer for detecting long pauses
	private finalizationTimer: NodeJS.Timeout | null = null

	// Glossary update timer for periodically refreshing code context
	private glossaryTimer: NodeJS.Timeout | null = null
	private readonly codeGlossary: VisibleCodeGlossary | null
	private readonly glossaryUpdateInterval = 3000 // 3 seconds

	constructor(
		emitter: STTEventEmitter,
		providerSettingsManager: ProviderSettingsManager,
		codeGlossary: VisibleCodeGlossary | null = null,
	) {
		this.emitter = emitter
		this.providerSettingsManager = providerSettingsManager
		this.codeGlossary = codeGlossary
		this.audioCapture = new FFmpegCaptureService()
	}

	async start(config: STTProviderConfig, language?: string): Promise<void> {
		// Cancel any previous session
		if (this.transcriptionClient) {
			this.cancel()
		}

		// Generate session ID (from OLD STTService)
		this.sessionId = `stt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
		this.config = config

		// Apply VAD config overrides
		if (config.vadConfig) {
			this.vadConfig = { ...DEFAULT_VAD_CONFIG, ...config.vadConfig }
		}

		// New session - reset ALL state BEFORE starting
		this.internalSessionId++
		this.isActive = true // Set BEFORE audio starts to avoid dropping first frames
		this.audioDataReceived = false // Reset audio data flag
		this.confirmedSegments = []
		this.currentPreviewText = ""

		// Reset VAD state
		this.bufferedAudioFrames = []
		this.bufferedAudioMs = 0
		this.voicedFrameCount = 0
		this.lastVoicedAtMs = Date.now()
		this.currentEnergy = 0

		const prompt = await this.codeGlossary?.getGlossary()

		if (prompt) {
			console.log(`🎙️ [STTService] 📝 Code glossary (${prompt.length} chars):`, prompt)
		} else {
			console.log(`🎙️ [STTService] 📝 No code glossary available`)
		}

		try {
			this.transcriptionClient = new OpenAIWhisperClient(this.providerSettingsManager, {
				apiKey: config.apiKey || "",
				language: language || config.language || "en",
				prompt,
			})

			this.setupEventHandlers()
			await this.connectClient()
			await this.startCapture()
			this.startGlossaryUpdater()
			this.startFinalizationTimer()

			this.emitter.onStarted(this.sessionId)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Failed to start"
			this.emitter.onStopped("error", undefined, errorMessage)
			await this.cleanupOnError()
			this.sessionId = null
			throw error
		}
	}

	async stop(): Promise<string> {
		if (!this.isActive) {
			// If we somehow stopped earlier, just return what we have
			const existingText = this.getFinalText()
			return existingText
		}

		this.isActive = false // Prevent new audio + late deltas
		const currentSession = this.internalSessionId

		// Stop timers immediately
		this.stopFinalizationTimer()
		this.stopGlossaryUpdater()

		try {
			await this.stopCapture()

			// Send final commit to flush remaining audio (if any)
			// Note: sendInputBufferCommit will check if there's enough audio internally
			if (this.transcriptionClient?.isConnected()) {
				this.transcriptionClient.sendInputBufferCommit()
				// Don't worry if it skips - it means buffer was already empty
			}

			// Wait for any pending transcriptions to arrive
			await new Promise((resolve) => setTimeout(resolve, 1000))

			// Convert any remaining preview to confirmed
			if (this.currentPreviewText.trim()) {
				this.confirmedSegments.push({ text: this.currentPreviewText.trim(), isPreview: false })
				this.currentPreviewText = ""
			}

			const finalText = this.getFullText()

			await this.disconnectClient()

			// Only reset if this is still the latest session
			if (this.internalSessionId === currentSession) {
				this.resetSession()
			}

			this.emitter.onStopped("completed", finalText)
			return finalText
		} catch (error) {
			console.error("🎙️ [STTService] Error during stop:", error)

			await this.disconnectClient()
			const finalText = this.getFinalText()

			if (this.internalSessionId === currentSession) {
				this.resetSession()
			}

			const errorMessage = error instanceof Error ? error.message : "Failed to stop"
			this.emitter.onStopped("error", finalText, errorMessage)
			return finalText
		}
	}

	cancel(): void {
		if (!this.transcriptionClient) {
			return
		}

		try {
			this.isActive = false
			this.stopFinalizationTimer()
			this.stopGlossaryUpdater()

			// Force cleanup
			this.transcriptionClient.disconnect().catch(() => {}) // Ignore during cancel
			this.audioCapture.stop().catch(() => {}) // Ignore during cancel

			this.resetSession()
			this.emitter.onStopped("cancelled")
		} catch (_error) {
			// Ignore errors during cancel
		}

		this.cleanup()
	}

	getSessionId(): string | null {
		return this.sessionId
	}

	isRecording(): boolean {
		return this.isActive
	}

	private setupEventHandlers(): void {
		this.connectAudioToClient()
		this.forwardTranscriptionEvents()
		this.handleErrors()
	}

	/**
	 * Connect audio capture to transcription client with local VAD logic
	 * Buffers audio frames and commits at natural word boundaries
	 */
	private connectAudioToClient(): void {
		// Handle audio frames with VAD-based buffering
		this.audioCapture.on("audioData", (pcm16Buffer: Buffer) => {
			if (!this.isActive) return

			// Mark that we've started receiving audio data
			if (!this.audioDataReceived) {
				this.audioDataReceived = true
			}

			const now = Date.now()

			// Only stream audio during voice activity (not continuous silence)
			// This prevents OpenAI from hallucinating prompt content during silence
			const silenceDuration = now - this.lastVoicedAtMs
			const isInVoiceWindow = silenceDuration < this.vadConfig.shortPauseMs

			if (isInVoiceWindow) {
				// Stream audio to OpenAI during voice activity or short pauses
				this.transcriptionClient?.sendAudioChunk(pcm16Buffer)

				// Track buffered audio for commit timing
				this.bufferedAudioFrames.push(pcm16Buffer)
				this.bufferedAudioMs += this.vadConfig.frameDurationMs

				// Check if we should commit at natural word boundaries
				// shouldCommitChunk() will log the commit reason
				if (this.shouldCommitChunk()) {
					this.sendCommitMarker()
				}
			} else {
				// Long silence detected - check if we should commit before clearing
				if (this.bufferedAudioFrames.length > 0) {
					const voicedRatio =
						this.bufferedAudioFrames.length > 0
							? this.voicedFrameCount / this.bufferedAudioFrames.length
							: 0

					// Only commit if we have enough audio AND enough voiced frames
					const hasEnoughAudio = this.bufferedAudioMs >= this.vadConfig.minChunkMs
					const hasEnoughVoice = voicedRatio >= this.vadConfig.minVoicedRatio

					if (hasEnoughAudio && hasEnoughVoice) {
						console.log(
							`🎙️ [STTService] 📤 Committing ${this.bufferedAudioMs}ms (${(voicedRatio * 100).toFixed(1)}% voiced) before clearing`,
						)
						this.transcriptionClient?.sendInputBufferCommit()
					} else {
						console.log(
							`🎙️ [STTService] ⏭️  Skipping commit: ${this.bufferedAudioMs}ms (${(voicedRatio * 100).toFixed(1)}% voiced, need ${(this.vadConfig.minVoicedRatio * 100).toFixed(0)}%)`,
						)
					}

					// Clear the buffer regardless
					console.log(`🎙️ [STTService] 🗑️  Clearing ${this.bufferedAudioMs}ms buffer after silence`)
					this.bufferedAudioFrames = []
					this.bufferedAudioMs = 0
					this.voicedFrameCount = 0
				}
			}
		})

		// Handle energy updates for VAD and UI
		this.audioCapture.on("audioEnergy", (energy: number) => {
			if (!this.isActive) return

			const now = Date.now()
			this.currentEnergy = energy

			if (this.isVoicedFrame(energy)) {
				this.lastVoicedAtMs = now
				// Track voiced frames while buffering
				const silenceDuration = now - this.lastVoicedAtMs
				const isBuffering = silenceDuration < this.vadConfig.shortPauseMs
				if (isBuffering && this.bufferedAudioFrames.length > 0) {
					this.voicedFrameCount++
				}
				// console.log(`🎙️ [STTService] 🗣️  Voice detected (energy: ${energy.toFixed(3)})`)
			}
			this.emitter.onVolume(energy)
		})
	}

	/**
	 * Determine if frame is voiced based on energy threshold
	 */
	private isVoicedFrame(energy: number): boolean {
		return energy > this.vadConfig.energyThreshold
	}
	/**
	 * Check if conditions met for committing current audio chunk
	 * Only commits on natural pauses to avoid splitting words mid-speech
	 * Also requires sufficient voiced content to prevent hallucination
	 */
	private shouldCommitChunk(): boolean {
		const now = Date.now()
		const silenceSinceMs = now - this.lastVoicedAtMs

		const hasEnoughAudio = this.bufferedAudioMs >= this.vadConfig.minChunkMs
		const atShortPause = silenceSinceMs >= this.vadConfig.shortPauseMs

		// Calculate voiced frame ratio
		const voicedRatio =
			this.bufferedAudioFrames.length > 0 ? this.voicedFrameCount / this.bufferedAudioFrames.length : 0
		const hasEnoughVoice = voicedRatio >= this.vadConfig.minVoicedRatio

		// Safety cap: if chunk exceeds maxChunkMs AND we're in a pause, commit
		// This prevents unbounded memory growth while still respecting speech boundaries
		const atSafetyCap = this.bufferedAudioMs >= this.vadConfig.maxChunkMs && atShortPause

		// Determine commit reason for logging
		let shouldCommit = false
		let commitReason = ""

		if (hasEnoughAudio && atShortPause && hasEnoughVoice) {
			shouldCommit = true
			commitReason = `natural pause (${silenceSinceMs}ms silence, ${this.bufferedAudioMs}ms audio, ${(voicedRatio * 100).toFixed(1)}% voiced)`
		} else if (atSafetyCap && hasEnoughVoice) {
			shouldCommit = true
			commitReason = `safety cap (${this.bufferedAudioMs}ms audio, ${(voicedRatio * 100).toFixed(1)}% voiced)`
		}

		// Log the decision
		if (shouldCommit && commitReason) {
			console.log(`🎙️ [STTService] ✓ Commit triggered: ${commitReason}`)
		}

		return shouldCommit
	}

	/**
	 * Send commit marker to transcription service
	 * This marks a boundary in the audio stream for transcription
	 * Audio has already been streamed continuously via sendAudioChunk
	 */
	private sendCommitMarker(): void {
		if (!this.transcriptionClient?.isConnected()) return
		if (this.bufferedAudioFrames.length === 0) return

		const voicedRatio = this.voicedFrameCount / this.bufferedAudioFrames.length
		console.log(
			`🎙️ [STTService] 📤 Committing ${this.bufferedAudioMs}ms of audio (${this.bufferedAudioFrames.length} frames, ${(voicedRatio * 100).toFixed(1)}% voiced)`,
		)

		// Send commit marker (audio was already streamed continuously)
		this.transcriptionClient.sendInputBufferCommit()

		// Clear tracking buffers (audio was already sent)
		this.bufferedAudioFrames = []
		this.bufferedAudioMs = 0
		this.voicedFrameCount = 0
	}

	private forwardTranscriptionEvents(): void {
		if (!this.transcriptionClient) return

		// Delta events: incremental word-by-word streaming (gpt-4o-mini-transcribe)
		// Each delta adds new text to build up the current preview
		this.transcriptionClient.on("transcriptionDelta", (delta: string) => {
			if (!this.isActive) return

			const trimmedDelta = delta.trim()
			const previousPreview = this.currentPreviewText

			// Append deltas to build up the current preview text
			this.currentPreviewText = (this.currentPreviewText + " " + trimmedDelta).trim()

			console.log(
				`🎙️ [STTService] 📝 Delta received: "${trimmedDelta}" | Preview now: "${this.currentPreviewText}" (was: "${previousPreview}")`,
			)

			// Emit current state (all segments)
			this.emitCurrentState()
		})

		// Completed event: OpenAI sends polished/corrected text
		this.transcriptionClient.on("transcription", (text: string) => {
			if (!this.isActive) return

			const trimmed = text.trim()
			if (!trimmed) return

			console.log(
				`🎙️ [STTService] ✅ Completion received: "${trimmed}" | Converting preview "${this.currentPreviewText}" to confirmed | Total confirmed before: ${this.confirmedSegments.length}`,
			)

			// Convert preview to confirmed segment
			this.confirmedSegments.push({ text: trimmed, isPreview: false })
			this.currentPreviewText = ""

			// Emit updated state
			this.emitCurrentState()
		})
	}

	/**
	 * Build and emit current transcript state
	 * Sends complete segments array to WebView
	 */
	private emitCurrentState(): void {
		const allSegments: STTSegment[] = [...this.confirmedSegments]

		// Add current preview if any
		if (this.currentPreviewText.trim()) {
			allSegments.push({ text: this.currentPreviewText.trim(), isPreview: true })
		}

		// Log what we're sending to WebView
		console.log(
			`🎙️ [STTService] 📨 Emitting to WebView: ${allSegments.length} segments`,
			JSON.stringify(
				allSegments.map((s) => ({
					text: s.text.slice(0, 50) + (s.text.length > 50 ? "..." : ""),
					isPreview: s.isPreview,
				})),
				null,
				2,
			),
		)

		this.emitter.onTranscript(allSegments, false)
	}

	private handleErrors(): void {
		this.audioCapture.on("error", (error: Error) => {
			console.error("🎙️ [STTService] Audio capture error:", error)
			// Handle gracefully - don't bubble up, just recover
			this.handleRecoverableError(error)
		})

		if (this.transcriptionClient) {
			this.transcriptionClient.on("error", (error: Error) => {
				console.error("🎙️ [STTService] Transcription API error:", error)
				// Handle gracefully - don't bubble up, just recover
				this.handleRecoverableError(error)
			})
		}
	}

	/**
	 * Handle recoverable errors by emitting to UI and cleaning up
	 * This ensures the UI knows recording has stopped
	 */
	private async handleRecoverableError(error: Error): Promise<void> {
		// Emit error to UI via STTEventEmitter
		this.emitter.onStopped("error", undefined, error.message)

		// If we're still active, clean up
		if (this.isActive) {
			try {
				await this.cleanupOnError()
			} catch (cleanupError) {
				console.error("Failed to cleanup after error:", cleanupError)
			}
		}
	}

	/**
	 * Strip ALL punctuation from text for interim display
	 * Only show clean text until VAD confirms the segment is done
	 */
	private stripPunctuation(text: string): string {
		// Remove ALL sentence-ending punctuation
		return text.replace(/[.!?]+\s*$/g, "").trim()
	}

	/**
	 * Get full text for onComplete callback
	 * Joins all confirmed segment texts
	 */
	private getFullText(): string {
		return this.confirmedSegments
			.map((s) => s.text)
			.join("")
			.trim()
	}

	private async connectClient(): Promise<void> {
		if (!this.transcriptionClient) {
			throw new Error("Transcription client not initialized")
		}
		await this.transcriptionClient.connect()
	}

	private async startCapture(): Promise<void> {
		await this.audioCapture.start()
	}

	/**
	 * Start finalization timer to check for long pauses
	 * Finalizes segments when user pauses for longPauseMs
	 */
	private startFinalizationTimer(): void {
		if (this.finalizationTimer) return

		let lastFinalizedAt = 0

		this.finalizationTimer = setInterval(() => {
			if (!this.isActive) return

			const now = Date.now()
			const silenceSinceMs = now - this.lastVoicedAtMs

			// Only finalize once per segment (not repeatedly during silence)
			if (silenceSinceMs >= this.vadConfig.longPauseMs && now - lastFinalizedAt > 1000) {
				if (this.currentPreviewText.trim()) {
					console.log(`🎙️ [STTService] 🔇 Long silence detected (${silenceSinceMs}ms) - finalizing preview`)
					// Convert preview to confirmed segment
					this.confirmedSegments.push({ text: this.currentPreviewText.trim(), isPreview: false })
					this.currentPreviewText = ""
					this.emitCurrentState()
					lastFinalizedAt = now
				}
			}
		}, 100) // Check every 100ms
	}

	/**
	 * Stop the finalization timer
	 */
	private stopFinalizationTimer(): void {
		if (this.finalizationTimer) {
			clearInterval(this.finalizationTimer)
			this.finalizationTimer = null
		}
	}

	/**
	 * Start periodic glossary updater to refresh code context during recording
	 * Only starts if a code glossary has been set
	 */
	private startGlossaryUpdater(): void {
		if (!this.codeGlossary) {
			return
		}

		this.glossaryTimer = setInterval(async () => {
			// Only update if service is still active
			if (!this.isActive || !this.codeGlossary) {
				return
			}

			try {
				// const updatedPrompt = await this.codeGlossary.getGlossary()
				// console.log(`🎙️ [STTService] 📝 Updated glossary (${updatedPrompt.length} chars):`, updatedPrompt)
				// this.transcriptionClient?.updateTranscriptionPrompt(updatedPrompt)
			} catch (error) {
				// Glossary update failures are non-critical - continue recording
				console.warn("🎙️ [STTService] Glossary update failed:", error)
			}
		}, this.glossaryUpdateInterval)
	}

	/**
	 * Stop the glossary updater
	 */
	private stopGlossaryUpdater(): void {
		if (this.glossaryTimer) {
			clearInterval(this.glossaryTimer)
			this.glossaryTimer = null
		}
	}

	private async stopCapture(): Promise<void> {
		try {
			await this.audioCapture.stop()
		} catch (error) {
			console.error("🎙️ [STTService] Error stopping audio capture:", error)
		}
	}

	private async disconnectClient(): Promise<void> {
		try {
			await this.transcriptionClient?.disconnect()
		} catch (error) {
			console.error("🎙️ [STTService] Error disconnecting client:", error)
		}
	}

	private getFinalText(): string {
		const text = this.getFullText()
		// console.log(`🎙️ [STTService] getFinalText() called, returning: "${text}"`)
		return text
	}

	private resetSession(): void {
		this.confirmedSegments = []
		this.currentPreviewText = ""
		this.audioDataReceived = false
	}

	private async cleanupOnError(): Promise<void> {
		this.isActive = false
		this.stopFinalizationTimer()
		this.stopGlossaryUpdater()

		// Force kill FFmpeg and disconnect - use Promise.allSettled to ensure both run
		const cleanupResults = await Promise.allSettled([
			this.audioCapture.stop(),
			this.transcriptionClient?.disconnect() ?? Promise.resolve(),
		])

		// Log cleanup results for debugging
		cleanupResults.forEach((result, index) => {
			const name = index === 0 ? "audioCapture" : "transcriptionClient"
			if (result.status === "rejected") {
				console.error(`🎙️ [STTService] Failed to cleanup ${name}:`, result.reason)
			} else {
				console.log(`🎙️ [STTService] ${name} cleaned up successfully`)
			}
		})

		this.resetSession()
	}

	private cleanup(): void {
		this.transcriptionClient = null
		this.sessionId = null
		this.config = null
	}
}
