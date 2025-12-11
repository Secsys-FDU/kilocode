import { describe, it, expect } from "vitest"
import { DEFAULT_VAD_CONFIG } from "../types"

/**
 * Calculate RMS energy of PCM16 audio frame
 * (Extracted from FFmpegCaptureService for testing)
 */
function calculateFrameEnergy(pcm16: Int16Array): number {
	let sum = 0
	for (let i = 0; i < pcm16.length; i++) {
		const normalized = pcm16[i] / 32768
		sum += normalized * normalized
	}
	const rms = Math.sqrt(sum / pcm16.length)
	return Math.min(rms, 1.0)
}

/**
 * Check if frame is voiced based on energy threshold
 */
function isVoicedFrame(energy: number, threshold: number = DEFAULT_VAD_CONFIG.energyThreshold): boolean {
	return energy > threshold
}

/**
 * Check if should commit chunk based on VAD logic
 */
function shouldCommitChunk(
	bufferedAudioMs: number,
	silenceSinceMs: number,
	minChunkMs: number = DEFAULT_VAD_CONFIG.minChunkMs,
	shortPauseMs: number = DEFAULT_VAD_CONFIG.shortPauseMs,
	maxChunkMs: number = DEFAULT_VAD_CONFIG.maxChunkMs,
): boolean {
	const hasEnoughAudio = bufferedAudioMs >= minChunkMs
	const atShortPause = silenceSinceMs >= shortPauseMs
	const tooLongChunk = bufferedAudioMs >= maxChunkMs

	return (hasEnoughAudio && atShortPause) || tooLongChunk
}

describe("VAD Energy Calculation", () => {
	it("should calculate zero energy for silence", () => {
		const silence = new Int16Array(480).fill(0) // 20ms at 24kHz
		const energy = calculateFrameEnergy(silence)
		expect(energy).toBe(0)
	})

	it("should calculate non-zero energy for audio", () => {
		const audio = new Int16Array(480)
		for (let i = 0; i < audio.length; i++) {
			audio[i] = Math.sin(i / 10) * 1000 // Sine wave
		}
		const energy = calculateFrameEnergy(audio)
		expect(energy).toBeGreaterThan(0)
		expect(energy).toBeLessThanOrEqual(1)
	})

	it("should cap energy at 1.0", () => {
		const loudAudio = new Int16Array(480).fill(32767) // Max PCM16 value
		const energy = calculateFrameEnergy(loudAudio)
		expect(energy).toBeCloseTo(1.0, 2) // Within 0.01 of 1.0
	})

	it("should calculate different energies for different amplitudes", () => {
		const quietAudio = new Int16Array(480).fill(1000)
		const loudAudio = new Int16Array(480).fill(10000)

		const quietEnergy = calculateFrameEnergy(quietAudio)
		const loudEnergy = calculateFrameEnergy(loudAudio)

		expect(loudEnergy).toBeGreaterThan(quietEnergy)
	})

	it("should detect voiced frames above threshold", () => {
		expect(isVoicedFrame(0.02, 0.015)).toBe(true) // Above threshold
		expect(isVoicedFrame(0.01, 0.015)).toBe(false) // Below threshold
		expect(isVoicedFrame(0.015, 0.015)).toBe(false) // Equal to threshold
	})
})

describe("VAD Chunking Logic", () => {
	it("should not commit before minChunkMs", () => {
		const bufferedMs = 200 // Below 300ms min
		const silenceMs = 150 // Above 120ms short pause

		const shouldCommit = shouldCommitChunk(bufferedMs, silenceMs)
		expect(shouldCommit).toBe(false)
	})

	it("should commit at short pause with enough audio", () => {
		const bufferedMs = 600 // Above 500ms min
		const silenceMs = 1100 // Above 1000ms short pause

		const shouldCommit = shouldCommitChunk(bufferedMs, silenceMs)
		expect(shouldCommit).toBe(true)
	})

	it("should not commit with enough audio but no pause", () => {
		const bufferedMs = 600 // Above 500ms min
		const silenceMs = 500 // Below 1000ms short pause

		const shouldCommit = shouldCommitChunk(bufferedMs, silenceMs)
		expect(shouldCommit).toBe(false)
	})

	it("should force commit at maxChunkMs", () => {
		const bufferedMs = 3100 // Above 3000ms max
		const silenceMs = 0 // No silence at all

		const shouldCommit = shouldCommitChunk(bufferedMs, silenceMs)
		expect(shouldCommit).toBe(true)
	})

	it("should not commit with short audio and short silence", () => {
		const bufferedMs = 100 // Below 300ms min
		const silenceMs = 50 // Below 120ms short pause

		const shouldCommit = shouldCommitChunk(bufferedMs, silenceMs)
		expect(shouldCommit).toBe(false)
	})

	it("should commit exactly at threshold values", () => {
		// Exactly at min audio + short pause
		expect(shouldCommitChunk(500, 1000)).toBe(true)

		// Exactly at max chunk
		expect(shouldCommitChunk(3000, 0)).toBe(true)
	})
})

describe("VAD Configuration", () => {
	it("should have sensible default values", () => {
		expect(DEFAULT_VAD_CONFIG.energyThreshold).toBe(0.02)
		expect(DEFAULT_VAD_CONFIG.minChunkMs).toBe(500)
		expect(DEFAULT_VAD_CONFIG.shortPauseMs).toBe(1000)
		expect(DEFAULT_VAD_CONFIG.longPauseMs).toBe(3000)
		expect(DEFAULT_VAD_CONFIG.maxChunkMs).toBe(3000)
		expect(DEFAULT_VAD_CONFIG.frameDurationMs).toBe(20)
	})

	it("should have longPauseMs > shortPauseMs", () => {
		expect(DEFAULT_VAD_CONFIG.longPauseMs).toBeGreaterThan(DEFAULT_VAD_CONFIG.shortPauseMs)
	})

	it("should have maxChunkMs > minChunkMs", () => {
		expect(DEFAULT_VAD_CONFIG.maxChunkMs).toBeGreaterThan(DEFAULT_VAD_CONFIG.minChunkMs)
	})

	it("should have reasonable frame duration", () => {
		// Frame duration should be between 10-30ms for real-time audio
		expect(DEFAULT_VAD_CONFIG.frameDurationMs).toBeGreaterThanOrEqual(10)
		expect(DEFAULT_VAD_CONFIG.frameDurationMs).toBeLessThanOrEqual(30)
	})
})

describe("VAD Edge Cases", () => {
	it("should handle zero-length audio frames", () => {
		const emptyFrame = new Int16Array(0)
		const energy = calculateFrameEnergy(emptyFrame)
		expect(isNaN(energy) || energy === 0).toBe(true)
	})

	it("should handle negative PCM values", () => {
		const negativeAudio = new Int16Array(480).fill(-10000)
		const energy = calculateFrameEnergy(negativeAudio)
		expect(energy).toBeGreaterThan(0)
		expect(energy).toBeLessThanOrEqual(1)
	})

	it("should handle mixed positive/negative values", () => {
		const mixedAudio = new Int16Array(480)
		for (let i = 0; i < mixedAudio.length; i++) {
			mixedAudio[i] = i % 2 === 0 ? 5000 : -5000
		}
		const energy = calculateFrameEnergy(mixedAudio)
		expect(energy).toBeGreaterThan(0)
		expect(energy).toBeLessThanOrEqual(1)
	})

	it("should handle very long buffer times", () => {
		const bufferedMs = 10000 // Very long
		const silenceMs = 0

		const shouldCommit = shouldCommitChunk(bufferedMs, silenceMs)
		expect(shouldCommit).toBe(true) // Should force commit
	})

	it("should handle very long silence", () => {
		const bufferedMs = 600
		const silenceMs = 5000 // Very long silence

		const shouldCommit = shouldCommitChunk(bufferedMs, silenceMs)
		expect(shouldCommit).toBe(true) // Should commit on pause
	})
})
