// ==========================================================
//  SERVER.JS — Пакетная обработка
// ==========================================================

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const async = require("async");

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
// ОДИНОЧНАЯ ГЕНЕРАЦИЯ
// --------------------------------------------
app.post(
    "/generate",
    upload.fields([
        { name: "objectImage", maxCount: 1 },
        { name: "backgroundImage", maxCount: 1 },
        { name: "additionalObjects", maxCount: 10 }
    ]),
    async (req, res) => {
        // ... существующий код для одиночной генерации ...
    }
);

// --------------------------------------------
// ПАКЕТНАЯ ГЕНЕРАЦИЯ
// --------------------------------------------
app.post(
    "/batch-generate",
    upload.fields([
        { name: "backgroundImage", maxCount: 1 },
        { name: "objectImages", maxCount: 100 } // До 100 объектов
    ]),
    async (req, res) => {
        const files = req.files || [];
        let tempFiles = [];

        try {
            const { prompt, quality, imageSize, batchName } = req.body;

            const backgroundFile = files.backgroundImage?.[0];
            const objectFiles = files.objectImages || [];

            if (!backgroundFile) {
                return res.status(400).json({ error: "Загрузите фоновое изображение" });
            }

            if (objectFiles.length === 0) {
                return res.status(400).json({ error: "Загрузите хотя бы один объект для пакетной обработки" });
            }

            console.log(`🔄 Начинаем пакетную обработку: ${objectFiles.length} объектов`);

            tempFiles = [backgroundFile.path, ...objectFiles.map(f => f.path)];

            // Создаем папку для результатов
            const batchId = batchName || `batch-${Date.now()}`;
            const batchDir = path.join("results", "batches", batchId);
            if (!fs.existsSync(batchDir)) {
                fs.mkdirSync(batchDir, { recursive: true });
            }

            const results = [];
            let processed = 0;
            let errors = 0;

            // Ограничиваем параллельные запросы чтобы не превысить лимиты API
            const queue = async.queue(async (objectFile, callback) => {
                try {
                    console.log(`🔨 Обрабатываем объект ${processed + 1}/${objectFiles.length}: ${objectFile.originalname}`);

                    const model = genAI.getGenerativeModel({
                        model: "gemini-3-pro-image-preview"
                    });

                    const parts = [
                        {
                            text: prompt || `Composite the object from the first image into the background scene from the second image.
                            Make perfect photorealism with accurate shadows, lighting, perspective.
                            Output ONLY the final composite image.`
                        },
                        {
                            inlineData: {
                                mimeType: getMimeType(objectFile.path),
                                data: fileToBase64(objectFile.path)
                            }
                        },
                        {
                            inlineData: {
                                mimeType: getMimeType(backgroundFile.path),
                                data: fileToBase64(backgroundFile.path)
                            }
                        }
                    ];

                    const generationConfig = {
                        responseModalities: ["IMAGE"],
                        imageConfig: {
                            aspectRatio: "1:1",
                            imageSize: imageSize || "2K"
                        }
                    };

                    const result = await model.generateContent({
                        contents: [{ role: "user", parts }],
                        generationConfig
                    });

                    const response = result.response;

                    let base64img = null;
                    for (const p of response?.candidates?.[0]?.content?.parts || []) {
                        if (p.inlineData) base64img = p.inlineData.data;
                    }

                    if (base64img) {
                        const R = resolutions[quality] || resolutions["2k"];
                        const filename = `batch-${batchId}-${path.parse(objectFile.originalname).name}.png`;
                        const filepath = path.join(batchDir, filename);

                        await sharp(Buffer.from(base64img, "base64"))
                            .resize(R.w, R.h, { fit: "inside", withoutEnlargement: false })
                            .png({ quality: 100 })
                            .toFile(filepath);

                        results.push({
                            success: true,
                            originalName: objectFile.originalname,
                            filename: filename,
                            url: `/batch-results/${batchId}/${filename}`,
                            resolution: `${R.w}x${R.h}`
                        });

                        processed++;
                    } else {
                        throw new Error("Модель не вернула изображение");
                    }

                } catch (error) {
                    console.error(`❌ Ошибка при обработке ${objectFile.originalname}:`, error.message);
                    results.push({
                        success: false,
                        originalName: objectFile.originalname,
                        error: error.message
                    });
                    errors++;
                }

                // Отправляем прогресс через SSE
                if (req.sse) {
                    req.sse.send({
                        type: 'progress',
                        processed,
                        total: objectFiles.length,
                        current: objectFile.originalname
                    });
                }

                callback();
            }, 2); // 2 параллельных запроса

            // Обработка завершения
            queue.drain = () => {
                console.log(`✅ Пакетная обработка завершена: ${processed} успешно, ${errors} ошибок`);

                // Создаем ZIP архив с результатами
                const archiver = require('archiver');
                const zipPath = path.join(batchDir, `${batchId}.zip`);
                const output = fs.createWriteStream(zipPath);
                const archive = archiver('zip', { zlib: { level: 9 } });

                output.on('close', () => {
                    results.zipUrl = `/batch-results/${batchId}/${batchId}.zip`;
                    
                    cleanup(tempFiles);
                    
                    res.json({
                        success: true,
                        batchId,
                        total: objectFiles.length,
                        processed,
                        errors,
                        results,
                        zipUrl: `/batch-results/${batchId}/${batchId}.zip`
                    });
                });

                archive.pipe(output);
                archive.directory(batchDir, false);
                archive.finalize();
            };

            // Добавляем файлы в очередь
            objectFiles.forEach(objectFile => {
                queue.push(objectFile);
            });

        } catch (e) {
            console.error("🔥 Ошибка пакетной обработки:", e);
            cleanup(tempFiles);
            return res.status(500).json({ error: e.message });
        }
    }
);

// --------------------------------------------
// СТАТИЧЕСКИЕ ФАЙЛЫ ДЛЯ ПАКЕТНЫХ РЕЗУЛЬТАТОВ
// --------------------------------------------
app.use("/batch-results", express.static(path.join(__dirname, "results", "batches")));

// --------------------------------------------
// ПОЛУЧЕНИЕ ИНФОРМАЦИИ О ПАКЕТЕ
// --------------------------------------------
app.get("/batch/:batchId", (req, res) => {
    const batchDir = path.join(__dirname, "results", "batches", req.params.batchId);
    if (!fs.existsSync(batchDir)) {
        return res.status(404).json({ error: "Пакет не найден" });
    }

    try {
        const files = fs.readdirSync(batchDir)
            .filter(f => f.endsWith('.png'))
            .map(f => ({
                filename: f,
                url: `/batch-results/${req.params.batchId}/${f}`,
                size: fs.statSync(path.join(batchDir, f)).size
            }));

        const zipFile = `${req.params.batchId}.zip`;
        const hasZip = fs.existsSync(path.join(batchDir, zipFile));

        res.json({
            batchId: req.params.batchId,
            files,
            zipUrl: hasZip ? `/batch-results/${req.params.batchId}/${zipFile}` : null,
            totalFiles: files.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --------------------------------------------
// DOWNLOAD
// --------------------------------------------
app.get("/results/:file", (req, res) => {
    const file = path.join(__dirname, "results", req.params.file);
    if (fs.existsSync(file)) return res.download(file);
    res.status(404).json({ error: "Файл не найден" });
});

app.get("/batch-results/:batchId/:file", (req, res) => {
    const file = path.join(__dirname, "results", "batches", req.params.batchId, req.params.file);
    if (fs.existsSync(file)) return res.download(file);
    res.status(404).json({ error: "Файл не найден" });
});

// --------------------------------------------
// BOOT
// --------------------------------------------
["public", "uploads", "results", "results/batches"].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
