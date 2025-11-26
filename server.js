// ==========================================================
//  SERVER.JS — Обновленная версия с поддержкой множественных объектов
// ==========================================================

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --------------------------------------------
// STATIC + FORM
// --------------------------------------------
app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --------------------------------------------
// File Upload
// --------------------------------------------
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = "uploads/";
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${Math.random()}-${file.originalname}`);
    }
});

const upload = multer({ storage });

// --------------------------------------------
// Utilities
// --------------------------------------------
const fileToBase64 = file => fs.readFileSync(file).toString("base64");

const getMimeType = file => {
    const ext = path.extname(file).toLowerCase();
    const map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp"
    };
    return map[ext] || "image/jpeg";
};

const resolutions = {
    "1k": { w: 1024, h: 1024 },
    "2k": { w: 2048, h: 2048 },
    "4k": { w: 4096, h: 4096 }
};

function cleanup(files) {
    files.forEach(f => f && fs.existsSync(f) && fs.unlinkSync(f));
}

// --------------------------------------------
// MAIN PAGE
// --------------------------------------------
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --------------------------------------------
// GENERATION ENDPOINT (обновленный для множественных объектов)
// --------------------------------------------
app.post(
    "/generate",
    upload.any(), // Изменено на any() для обработки произвольных файлов
    async (req, res) => {
        const files = req.files || [];
        let tempFiles = [];

        try {
            const { prompt, imageSize, quality, totalObjects } = req.body;

            // Разделяем файлы на объекты и фон
            const objectFiles = files.filter(f => f.fieldname.startsWith('objectImage') || f.fieldname.startsWith('additionalObject'));
            const backgroundFile = files.find(f => f.fieldname === 'backgroundImage');

            if (!objectFiles.length) {
                return res.status(400).json({ error: "Загрузите хотя бы один объект" });
            }

            if (!backgroundFile) {
                return res.status(400).json({ error: "Загрузите фоновое изображение" });
            }

            tempFiles = [...objectFiles.map(f => f.path), backgroundFile.path];

            // MODEL
            const model = genAI.getGenerativeModel({
                model: "gemini-3-pro-image-preview"
            });

            // Собираем части контента
            const parts = [
                {
                    text: prompt || `Composite ${objectFiles.length} object(s) from the provided images into the background image.
                     Create perfect photorealism with accurate shadows, lighting, perspective, and color grading.
                     Arrange the objects harmoniously in the scene.
                     Output ONLY the final composite image.`
                }
            ];

            // Добавляем изображения объектов
            objectFiles.forEach(file => {
                parts.push({
                    inlineData: {
                        mimeType: getMimeType(file.path),
                        data: fileToBase64(file.path)
                    }
                });
            });

            // Добавляем фоновое изображение
            parts.push({
                inlineData: {
                    mimeType: getMimeType(backgroundFile.path),
                    data: fileToBase64(backgroundFile.path)
                }
            });

            // CONTENT
            const contents = [{ role: "user", parts }];

            // CONFIG
            const generationConfig = {
                responseModalities: ["IMAGE"],
                imageConfig: {
                    aspectRatio: "1:1",
                    imageSize: imageSize || "2K"
                }
            };

            // REQUEST
            console.log(`📡 Запрос в Gemini 3 Pro Image с ${objectFiles.length} объектами...`);
            const result = await model.generateContent({
                contents,
                generationConfig
            });

            const response = result.response;

            let base64img = null;
            for (const p of response?.candidates?.[0]?.content?.parts || []) {
                if (p.inlineData) base64img = p.inlineData.data;
            }

            if (!base64img) throw new Error("Модель не вернула изображение");

            // SAVE RESULT (SHARP UPSCALE)
            const resDir = "results/";
            if (!fs.existsSync(resDir)) fs.mkdirSync(resDir, { recursive: true });

            const R = resolutions[quality] || resolutions["2k"];
            const filename = `result-${Date.now()}-${quality}.png`;
            const filepath = path.join(resDir, filename);

            await sharp(Buffer.from(base64img, "base64"))
                .resize(R.w, R.h, { fit: "inside", withoutEnlargement: false })
                .png({ quality: 100 })
                .toFile(filepath);

            cleanup(tempFiles);

            return res.json({
                success: true,
                imageUrl: `/results/${filename}`,
                filename,
                resolution: `${R.w}x${R.h}`,
                objectsCount: objectFiles.length
            });

        } catch (e) {
            console.error("🔥 Ошибка:", e);
            cleanup(tempFiles);
            return res.status(500).json({ error: e.message });
        }
    }
);

// --------------------------------------------
// DOWNLOAD
// --------------------------------------------
app.get("/results/:file", (req, res) => {
    const file = path.join(__dirname, "results", req.params.file);
    if (fs.existsSync(file)) return res.download(file);
    res.status(404).json({ error: "Файл не найден" });
});

// --------------------------------------------
// BOOT
// --------------------------------------------
["public", "uploads", "results"].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
