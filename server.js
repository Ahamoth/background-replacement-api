// ===============================================
//  SERVER.JS — полностью обновлённая версия
//  Поддержка: gemini-3-pro-preview + inlineData
// ===============================================

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// -------------------------
// Middleware
// -------------------------
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// -------------------------
// Multer upload
// -------------------------
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = 'uploads/';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        cb(null, `${Date.now()}-${Math.random()}-${file.originalname}`);
    }
});
const upload = multer({ storage });

// -------------------------
// Utils
// -------------------------
function fileToBase64(filePath) {
    return fs.readFileSync(filePath).toString("base64");
}

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif"
    };
    return map[ext] || "image/jpeg";
}

function getResolution(quality) {
    const map = {
        "1k": { width: 1024, height: 1024 },
        "2k": { width: 2048, height: 2048 },
        "4k": { width: 4096, height: 4096 }
    };
    return map[quality] || map["2k"];
}

function cleanupFiles(paths) {
    paths.forEach(p => {
        if (p && fs.existsSync(p)) fs.unlinkSync(p);
    });
}

// -------------------------
// ROUTES
// -------------------------
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/generate", upload.fields([
    { name: "objectImage", maxCount: 1 },
    { name: "backgroundImage", maxCount: 1 }
]), async (req, res) => {
    let objectImage = null;
    let backgroundImage = null;

    try {
        const {
            prompt,
            thinkingLevel,
            mediaResolution,
            quality
        } = req.body;

        // validate files
        if (!req.files?.objectImage || !req.files?.backgroundImage) {
            return res.status(400).json({ error: "Оба изображения обязательны" });
        }

        objectImage = req.files.objectImage[0];
        backgroundImage = req.files.backgroundImage[0];

        // -------------------------
        // Gemini 3 Pro model
        // -------------------------
        const model = genAI.getGenerativeModel({
            model: "gemini-3-pro-preview"
        });

        // -------------------------
        // Create content
        // -------------------------
        const contents = [
            {
                role: "user",
                parts: [
                    { text: prompt || "Combine the object with the background realistically." },
                    {
                        inlineData: {
                            mimeType: getMimeType(objectImage.path),
                            data: fileToBase64(objectImage.path)
                        }
                    },
                    {
                        inlineData: {
                            mimeType: getMimeType(backgroundImage.path),
                            data: fileToBase64(backgroundImage.path)
                        }
                    }
                ]
            }
        ];

        const generationConfig = {
            temperature: 0.7,
            topP: 0.9,
            mediaResolution: mediaResolution,
            thinking: thinkingLevel
        };

        // -------------------------
        // Send request
        // -------------------------
        const result = await model.generateContent({
            contents,
            generationConfig
        });

        const response = result.response;

        if (!response?.candidates?.length) {
            throw new Error("Gemini не вернул кандидатов");
        }

        let imageBase64 = null;
        for (const part of response.candidates[0].content.parts) {
            if (part.inlineData) {
                imageBase64 = part.inlineData.data;
            }
        }

        if (!imageBase64) {
            throw new Error("Gemini вернул ответ без изображения");
        }

        // -------------------------
        // Save result
        // -------------------------
        const resultDir = "results/";
        if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir, { recursive: true });

        const resolution = getResolution(quality);

        const filename = `result-${Date.now()}.png`;
        const filepath = path.join(resultDir, filename);

        await sharp(Buffer.from(imageBase64, "base64"))
            .resize(resolution.width, resolution.height, { fit: "inside" })
            .png()
            .toFile(filepath);

        cleanupFiles([objectImage.path, backgroundImage.path]);

        res.json({
            success: true,
            imageUrl: `/results/${filename}`,
            filename: filename
        });

    } catch (err) {
        console.error("❌ Ошибка:", err);
        cleanupFiles([objectImage?.path, backgroundImage?.path]);
        res.status(500).json({ error: err.message });
    }
});

app.get('/results/:filename', (req, res) => {
    const filePath = path.join(__dirname, 'results', req.params.filename);
    if (fs.existsSync(filePath)) return res.download(filePath);
    res.status(404).json({ error: "Файл не найден" });
});

// -------------------------
// Run server
// -------------------------
["public", "uploads", "results"].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
