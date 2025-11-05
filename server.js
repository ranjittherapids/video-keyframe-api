// server.js
const express = require("express");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const fsSync = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const tempDir = path.join(__dirname, "temp");
    if (!fsSync.existsSync(tempDir)) {
      await fs.mkdir(tempDir, { recursive: true });
    }
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      "video/mp4",
      "video/mpeg",
      "video/quicktime",
      "video/x-msvideo",
      "video/webm",
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only video files are allowed."));
    }
  },
});

/**
 * Download video from URL to temp directory
 */
async function downloadVideo(url) {
  const tempDir = path.join(__dirname, "temp");
  if (!fsSync.existsSync(tempDir)) {
    await fs.mkdir(tempDir, { recursive: true });
  }

  const videoPath = path.join(tempDir, `${uuidv4()}.mp4`);
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
 * POST /extract-keyframes
 * Extract key frames from video (URL or upload)
 */
app.post("/extract-keyframes", upload.single("video"), async (req, res) => {
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

    // Handle video source (URL or file upload)
    if (req.body.videoUrl) {
      // Download from URL
      try {
        videoPath = await downloadVideo(req.body.videoUrl);
      } catch (err) {
        return res.status(400).json({
          error: "Failed to download video from URL",
          details: err.message,
        });
      }
    } else if (req.file) {
      // Use uploaded file
      videoPath = req.file.path;
    } else {
      return res.status(400).json({
        error: "Either videoUrl or video file must be provided",
      });
    }

    // Create unique output directory
    const videoId = uuidv4();
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
    });
  } catch (err) {
    console.error("Error:", err);

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
  console.log(`📍 GET /health - Health check`);
});

module.exports = app;
