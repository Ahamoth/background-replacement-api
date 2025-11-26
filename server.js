// ==========================================================
//  SERVER.JS — Полностью готовая версия для gemini-2.0-flash
//  Поддерживает: Image Composition + 1K / 2K / 4K
// ==========================================================

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------
// ИНИЦИАЛИЗАЦИЯ GEMINI
// ------------------------------
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ------------------------------
// MIDDLEWARE
// ------------------------------
app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ------------------------------
// MULTER (UPLOADS)
// ------------------------------
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = "uploads/";
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`);
    }
});

const upload = multer({ storage });

// ------------------------------
// HELPERS
// ------------------------------
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

// ------------------------------
// ROUTES
// ------------------------------
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ------------------------------
// MAIN GENERATION ENDPOINT
// ------------------------------
app.post(
    "/generate",
    upload.fields([
        { name: "objectImage", maxCount: 1 },
        { name: "backgroundImage", maxCount: 1 }
    ]),
    async (req, res) => {
        let objImg = null;
        let bgImg = null;

        try {
            const { prompt, mediaResolution, quality } = req.body;

            // Validate
            if (!req.files?.objectImage || !req.files?.backgroundImage) {
                return res.status(400).json({ error: "Оба изображения обязательны" });
            }

            objImg = req.files.objectImage[0];
            bgImg = req.files.backgroundImage[0];

            // --------------------------
            // MODEL: GEMINI-2.0-FLASH
            // --------------------------
            const model = genAI.getGenerativeModel({
                model: "gemini-2.0-flash"
            });

            // --------------------------
            // INPUT CONTENTS
            // --------------------------
            const contents = [
                {
                    role: "user",
                    parts: [
                        {
                            text:
                                prompt ||
                                `Integrate the object image into the background image 
                                with perfect lighting, shadows, perspective, soft edges 
                                and full photorealism. Return ONLY final composite image.`
                        },
                        {
                            inlineData: {
                                mimeType: getMimeType(objImg.path),
                                data: fileToBase64(objImg.path)
                            }
                        },
                        {
                            inlineData: {
                                mimeType: getMimeType(bgImg.path),
                                data: fileToBase64(bgImg.path)
                            }
                        }
                    ]
                }
            ];

            // --------------------------
            // GENERATION CONFIG
            // --------------------------
            const generationConfig = {
                temperature: 0.7,
                topP: 0.95,
                mediaResolution: mediaResolution || "MEDIA_RESOLUTION_HIGH"
            };

            // --------------------------
            // REQUEST
            // --------------------------
            console.log("📡 Запрос в Gemini 2.0 Flash...");
            const result = await model.generateContent({
                contents,
                generationConfig
            });

            const response = result.response;

            if (!response?.candidates?.length) {
                throw new Error("Gemini не предоставил кандидатов");
            }

            // --------------------------
            // FIND IMAGE (inlineData)
            // --------------------------
            let imageBase64 = null;

            for (const part of response.candidates[0].content.parts) {
                if (part.inlineData) {
                    imageBase64 = part.inlineData.data;
                }
            }

            if (!imageBase64) {
                throw new Error("Gemini вернул ответ без изображения");
            }

            // --------------------------
            // SAVE RESULT (WITH UPSCALE)
            // --------------------------
            const resultDir = "results/";
            if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir, { recursive: true });

            const resolution = getResolution(quality || "2k");
            const filename = `result-${Date.now()}-${quality}.png`;
            const filepath = path.join(resultDir, filename);

            await sharp(Buffer.from(imageBase64, "base64"))
                .resize(resolution.width, resolution.height, {
                    fit: "inside",
                    withoutEnlargement: false
                })
                .png({ quality: 100 })
                .toFile(filepath);

            // CLEANUP TEMP FILES
            cleanupFiles([objImg.path, bgImg.path]);

            // SUCCESS
            res.json({
                success: true,
                imageUrl: `/results/${filename}`,
                filename,
                resolution: `${resolution.width}x${resolution.height}`
            });
        } catch (err) {
            console.error("❌ Ошибка:", err);
            cleanupFiles([objImg?.path, bgImg?.path]);
            res.status(500).json({ error: err.message });
        }
    }
);

// ------------------------------
// DOWNLOAD
// ------------------------------
app.get("/results/:filename", (req, res) => {
    const file = path.join(__dirname, "results", req.params.filename);
    if (fs.existsSync(file)) return res.download(file);
    res.status(404).json({ error: "Файл не найден" });
});

// ------------------------------
// START SERVER
// ------------------------------
["public", "uploads", "results"].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
});
