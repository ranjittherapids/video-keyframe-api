// server.js
const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const { randomUUID } = require("crypto");
const fsSync = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const LOGS_DIR = path.join(__dirname, "logs");
const DOWNLOAD_LOG_FILE = path.join(LOGS_DIR, "video-download.log");

// Middleware
app.use(express.json());

async function ensureDirectory(dirPath) {
  if (!fsSync.existsSync(dirPath)) {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

async function logDownloadEvent(level, message, metadata = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...metadata,
  };

  try {
    await ensureDirectory(LOGS_DIR);
    await fs.appendFile(DOWNLOAD_LOG_FILE, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    console.error("Failed to write log file:", err.message);
  }
}

/**
 * Download video from URL to temp directory
 */
async function downloadVideo(url) {
  const tempDir = path.join(__dirname, "temp");
  await ensureDirectory(tempDir);

    const videoPath = path.join(tempDir, `${randomUUID()}.mp4`);
  const writer = fsSync.createWriteStream(videoPath);

  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
    timeout: 60000,
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", () => resolve(videoPath));
    writer.on("error", reject);
  });
}

/**
 * Extract key frames from video using FFmpeg
 */
async function extractKeyframes(videoPath, interval, outputDir) {
  return new Promise((resolve, reject) => {
    const frames = [];
    let frameCount = 0;

    ffmpeg(videoPath)
      .outputOptions([
        `-vf fps=1/${interval}`, // Extract frame every N seconds
        "-q:v 2", // Quality (2 is high quality)
      ])
      .output(path.join(outputDir, "frame_%d.jpg"))
      .on("end", async () => {
        // Read all extracted frames
        const files = await fs.readdir(outputDir);
        const frameFiles = files
          .filter((f) => f.startsWith("frame_"))
          .sort((a, b) => {
            const numA = parseInt(a.match(/\d+/)[0]);
            const numB = parseInt(b.match(/\d+/)[0]);
            return numA - numB;
          })
          .map((f) => path.join(outputDir, f));

        resolve(frameFiles);
      })
      .on("error", (err) => {
        reject(new Error(`FFmpeg error: ${err.message}`));
      })
      .run();
  });
}

/**
 * Clean up temporary files
 */
async function cleanup(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    console.error(`Failed to cleanup ${filePath}:`, err.message);
  }
}

/**
 * Format duration in seconds to time string (e.g., "0:59" or "1:23:45")
 */
function formatDuration(seconds) {
  if (!seconds || seconds === 0) return "0:00";
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Get video metadata using ffprobe
 */
function getVideoMetadata(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);

      const videoStream = metadata.streams.find(
        (s) => s.codec_type === "video"
      );

      if (!videoStream) {
        return reject(new Error("No video stream found"));
      }

      const width = videoStream.width;
      const height = videoStream.height;
      const duration = metadata.format.duration || 0;
      const durationFormatted = formatDuration(duration);
      const size = metadata.format.size || 0;
      const bitrate = metadata.format.bit_rate || 0;
      const codec = videoStream.codec_name || "unknown";

      // Parse frame rate (format: "30/1" or "25/1")
      let fps = 0;
      if (videoStream.r_frame_rate) {
        const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
        fps = den ? num / den : num;
      }

      // A short video is typically vertical (height > width) - like TikTok/Instagram Reels
      const isShort = height > width;

      resolve({
        width,
        height,
        duration,
        durationFormatted,
        size,
        bitrate,
        codec,
        fps,
        isShort,
      });
    });
  });
}

/**
 * POST /extract-keyframes
 * Extract key frames from video URL
 */
app.post("/extract-keyframes", async (req, res) => {
  let videoPath = null;
  let outputDir = null;

  try {
    // Get interval (default to 5 seconds)
    const interval = parseInt(req.body.interval) || 5;

    if (interval < 1 || interval > 60) {
      return res.status(400).json({
        error: "Interval must be between 1 and 60 seconds",
      });
    }

    // Handle video source (URL only)
    const { videoUrl } = req.body;
    if (!videoUrl) {
      return res.status(400).json({
        error: "videoUrl is required",
      });
    }

    await logDownloadEvent("info", "Received extract request", {
      videoUrl,
      interval,
      clientIp: req.ip,
      userAgent: req.get("user-agent") || null,
    });

    let parsedUrl;
    try {
      parsedUrl = new URL(videoUrl);
    } catch (err) {
      return res.status(400).json({
        error: "videoUrl must be a valid URL",
      });
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).json({
        error: "videoUrl must use http or https protocol",
      });
    }

    // Download from URL
    try {
      videoPath = await downloadVideo(videoUrl);
    } catch (err) {
      await logDownloadEvent("error", "Download failed", {
        videoUrl,
        statusCode: err.response?.status || null,
        statusText: err.response?.statusText || null,
        errorMessage: err.message,
      });
      return res.status(400).json({
        error: "Failed to download video from URL",
        details: err.message,
      });
    }

    // Get video metadata
    const videoMetadata = await getVideoMetadata(videoPath);
 
    // Create unique output directory
    const videoId = randomUUID();
    outputDir = path.join(__dirname, "uploads", videoId);
    await fs.mkdir(outputDir, { recursive: true });

    // Extract keyframes
    const keyFramePaths = await extractKeyframes(
      videoPath,
      interval,
      outputDir
    );

    // Build full URLs for each frame
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const frameUrls = keyFramePaths.map((framePath) => {
      const frameName = path.basename(framePath);
      return `${baseUrl}/frames/${videoId}/${frameName}`;
    });

    res.json({
      success: true,
      videoId,
      interval,
      frameCount: frameUrls.length,
      keyFrames: frameUrls,
      metadata: {
        width: videoMetadata.width,
        height: videoMetadata.height,
        duration: videoMetadata.durationFormatted, 
        size: videoMetadata.size,
        bitrate: videoMetadata.bitrate,
        codec: videoMetadata.codec,
        fps: videoMetadata.fps,
      },
      is_short: videoMetadata.isShort,
    });
    await logDownloadEvent("info", "Extract completed", {
      videoUrl,
      frameCount: frameUrls.length,
      videoId,
    });
  } catch (err) {
    console.error("Error:", err);
    await logDownloadEvent("error", "Extract failed", {
      errorMessage: err.message,
      stack: err.stack || null,
    });

    // Cleanup on error
    if (outputDir) {
      try {
        await fs.rm(outputDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.error("Cleanup error:", cleanupErr);
      }
    }

    res.status(500).json({
      error: "Failed to extract keyframes",
      details: err.message,
    });
  } finally {
    // Cleanup temp video file
    if (videoPath) {
      await cleanup(videoPath);
    }
  }
});

/**
 * GET /logs/download
 * Download server download log file
 */
app.get("/logs/download", async (req, res) => {
  try {
    if (!fsSync.existsSync(DOWNLOAD_LOG_FILE)) {
      return res.status(404).json({ error: "Log file not found" });
    }
    return res.download(DOWNLOAD_LOG_FILE, "video-download.log");
  } catch (err) {
    return res.status(500).json({
      error: "Failed to download log file",
      details: err.message,
    });
  }
});

/**
 * GET /frames/:videoId/:frameName
 * Serve extracted frame images
 */
app.get("/frames/:videoId/:frameName", (req, res) => {
  const framePath = path.join(
    __dirname,
    "uploads",
    req.params.videoId,
    req.params.frameName
  );

  if (!fsSync.existsSync(framePath)) {
    return res.status(404).json({ error: "Frame not found" });
  }

  res.sendFile(framePath);
});

/**
 * DELETE /frames/:videoId
 * Delete all frames for a video
 */
app.delete("/frames/:videoId", async (req, res) => {
  try {
    const videoDir = path.join(__dirname, "uploads", req.params.videoId);
    await fs.rm(videoDir, { recursive: true, force: true });
    res.json({ success: true, message: "Frames deleted successfully" });
  } catch (err) {
    res.status(500).json({
      error: "Failed to delete frames",
      details: err.message,
    });
  }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    details: err.message,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Keyframe extraction API running on port ${PORT}`);
  console.log(`📍 POST /extract-keyframes - Extract frames from video`);
  console.log(`📍 GET /frames/:videoId/:frameName - Retrieve frame image`);
  console.log(`📍 DELETE /frames/:videoId - Delete all frames`);
  console.log(`📍 GET /logs/download - Download server log file`);
  console.log(`📍 GET /health - Health check`);
});

module.exports = app;
