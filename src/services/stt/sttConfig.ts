// kilocode_change - new file: FFmpeg availability check
import * as os from "os"

/**
 * Cached FFmpeg availability result
 * Prevents redundant checks since FFmpeg installation doesn't change during runtime
 */
let cachedResult: { available: boolean; path?: string; error?: string } | null = null

/**
 * Check if FFmpeg is available on the system
 * Results are cached to prevent redundant checks
 *
 * @param forceRecheck - Force a fresh check, ignoring cache (default: false)
 */
export async function checkFFmpegAvailability(
	forceRecheck = false,
): Promise<{ available: boolean; path?: string; error?: string }> {
	// Return cached result if available and not forcing recheck
	if (cachedResult !== null && !forceRecheck) {
		return cachedResult
	}

	const platform = os.platform()
	const command = "ffmpeg"

	console.log(`🎙️ [FFmpeg Check] Platform: ${platform}`)
	console.log(`🎙️ [FFmpeg Check] Checking if '${command}' is in PATH...`)

	// Platform-specific fallback paths
	const fallbackPaths: Record<string, string[]> = {
		darwin: ["/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"],
		linux: ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/snap/bin/ffmpeg"],
		win32: [
			"C:\\ffmpeg\\bin\\ffmpeg.exe",
			"C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
			"C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe",
		],
	}

	try {
		const { execSync } = await import("child_process")
		execSync(`${command} -version`, { stdio: "ignore" })
		console.log(`🎙️ [FFmpeg Check] ✅ Found '${command}' in PATH`)
		cachedResult = { available: true, path: command }
		return cachedResult
	} catch (error) {
		console.log(`🎙️ [FFmpeg Check] ❌ '${command}' not found in PATH`)
		console.log(`🎙️ [FFmpeg Check] Trying fallback paths for ${platform}...`)

		// Check fallback paths for this platform
		const platformPaths = fallbackPaths[platform] || []
		console.log(`🎙️ [FFmpeg Check] Fallback paths to check: ${platformPaths.join(", ")}`)

		for (const fallbackPath of platformPaths) {
			try {
				console.log(`🎙️ [FFmpeg Check] Checking: ${fallbackPath}`)
				const { execSync } = await import("child_process")
				execSync(`"${fallbackPath}" -version`, { stdio: "ignore" })
				console.log(`🎙️ [FFmpeg Check] ✅ Found FFmpeg at: ${fallbackPath}`)
				cachedResult = { available: true, path: fallbackPath }
				return cachedResult
			} catch {
				console.log(`🎙️ [FFmpeg Check] ❌ Not found at: ${fallbackPath}`)
				continue
			}
		}
	}

	console.log(`🎙️ [FFmpeg Check] ❌ FFmpeg not found anywhere`)
	console.log(`🎙️ [FFmpeg Check] Install instructions: https://ffmpeg.org/download.html`)

	cachedResult = {
		available: false,
		error: `FFmpeg not found. Please install FFmpeg to use speech-to-text.`,
	}
	return cachedResult
}
