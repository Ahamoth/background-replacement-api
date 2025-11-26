// ==========================================================
//  SERVER.JS — Полная версия для gemini-3-pro-image-preview
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
// GENERATION ENDPOINT
// --------------------------------------------
app.post(
    "/generate",
    upload.fields([
        { name: "objectImage", maxCount: 1 },
        { name: "backgroundImage", maxCount: 1 }
    ]),
    async (req, res) => {

        let obj = null, bg = null;

        try {
            const { prompt, imageSize, quality } = req.body;

            if (!req.files?.objectImage || !req.files?.backgroundImage) {
                return res.status(400).json({ error: "Загрузите оба изображения" });
            }

            obj = req.files.objectImage[0];
            bg = req.files.backgroundImage[0];

            // MODEL
            const model = genAI.getGenerativeModel({
                model: "gemini-3-pro-image-preview"
            });

            // CONTENT
            const contents = [
                {
                    role: "user",
                    parts: [
                        {
                            text:
                                prompt ||
                                `Composite the first image (object) into the second image (background).
                                 Make perfect photorealism, shadow matching, lighting alignment, 
                                 physical perspective, soft edges, realistic color grading.
                                 Output ONLY the final composite image.`
                        },
                        {
                            inlineData: {
                                mimeType: getMimeType(obj.path),
                                data: fileToBase64(obj.path)
                            }
                        },
                        {
                            inlineData: {
                                mimeType: getMimeType(bg.path),
                                data: fileToBase64(bg.path)
                            }
                        }
                    ]
                }
            ];

            // CONFIG
            const generationConfig = {
                responseModalities: ["IMAGE"],
                imageConfig: {
                    aspectRatio: "1:1",
                    imageSize: imageSize || "2K"
                }
            };

            // REQUEST
            console.log("📡 Запрос в Gemini 3 Pro Image...");
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

            cleanup([obj.path, bg.path]);

            return res.json({
                success: true,
                imageUrl: `/results/${filename}`,
                filename,
                resolution: `${R.w}x${R.h}`
            });

        } catch (e) {
            console.error("🔥 Ошибка:", e);
            cleanup([obj?.path, bg?.path]);
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
