const express = require('express');
const multer = require('multer');
const { GoogleGenAI } = require('@google/genai');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Инициализация Google GenAI
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Функция для чтения файла в base64
function fileToBase64(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  return fileBuffer.toString('base64');
}

// Функция для получения MIME типа файла
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  };
  return mimeTypes[ext] || 'image/jpeg';
}

// Основной маршрут
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Маршрут для обработки генерации
app.post('/generate', upload.fields([
  { name: 'objectImage', maxCount: 1 },
  { name: 'backgroundImage', maxCount: 1 }
]), async (req, res) => {
  let objectImage, backgroundImage;
  
  try {
    const { prompt, thinkingLevel, mediaResolution } = req.body;
    
    console.log('📦 Полученные данные:');
    console.log('   prompt:', prompt);
    console.log('   thinkingLevel:', thinkingLevel);
    console.log('   mediaResolution:', mediaResolution);
    
    // Проверка наличия файлов
    if (!req.files || !req.files['objectImage'] || !req.files['backgroundImage']) {
      return res.status(400).json({ error: 'Оба изображения обязательны' });
    }
    
    objectImage = req.files['objectImage'][0];
    backgroundImage = req.files['backgroundImage'][0];

    console.log('🚀 Начинаем генерацию...');

    // Конфигурация строго по формату из примера
    const tools = [
      {
        googleSearch: {}
      },
    ];

    const config = {
      thinkingConfig: {
        thinkingLevel: thinkingLevel || 'HIGH',
      },
      mediaResolution: mediaResolution || 'MEDIA_RESOLUTION_HIGH',
      tools,
    };

    const model = 'gemini-3-pro-preview';

    const finalPrompt = prompt || "Create a photorealistic composite by integrating the object from first image into the background from second image with realistic lighting and shadows.";

    // Подготовка содержимого строго по формату из примера
    const contents = [
      {
        role: 'user',
        parts: [
          {
            text: finalPrompt,
          },
          {
            fileData: {
              mimeType: getMimeType(objectImage.path),
              data: fileToBase64(objectImage.path)
            }
          },
          {
            fileData: {
              mimeType: getMimeType(backgroundImage.path),
              data: fileToBase64(backgroundImage.path)
            }
          }
        ]
      }
    ];

    console.log('📡 Отправляем запрос к Gemini API...');
    console.log('⚙️ Конфигурация:', JSON.stringify(config, null, 2));
    
    // Используем generateContentStream как в примере
    const response = await ai.models.generateContentStream({
      model,
      config,
      contents,
    });

    console.log('✅ Запрос успешен!');

    // Обработка stream ответа
    let fullText = '';
    let imageData = null;

    for await (const chunk of response) {
      if (chunk.text) {
        fullText += chunk.text;
      }
      
      // Проверяем наличие inlineData (изображение) в кандидатах
      if (chunk.candidates && chunk.candidates.length > 0) {
        const candidate = chunk.candidates[0];
        if (candidate.content && candidate.content.parts) {
          for (const part of candidate.content.parts) {
            if (part.inlineData) {
              imageData = Buffer.from(part.inlineData.data, 'base64');
              break;
            }
          }
        }
      }
    }

    if (imageData) {
      // Сохраняем результат
      const resultDir = 'results/';
      if (!fs.existsSync(resultDir)) {
        fs.mkdirSync(resultDir, { recursive: true });
      }
      
      const timestamp = Date.now();
      const filename = `result-${timestamp}.png`;
      const filePath = path.join(resultDir, filename);
      
      await sharp(imageData)
        .png({ quality: 100 })
        .toFile(filePath);
      
      console.log(`✅ Изображение сохранено: ${filename}`);
      
      // Очищаем временные файлы
      cleanupFiles([objectImage.path, backgroundImage.path]);
      
      return res.json({
        success: true,
        imageUrl: `/results/${filename}`,
        filename: filename
      });
    } else if (fullText) {
      console.log('📝 Текстовый ответ:', fullText);
      return res.status(500).json({ 
        error: `API вернул текст вместо изображения: ${fullText.substring(0, 100)}...` 
      });
    }
    
    return res.status(500).json({ error: 'В ответе нет изображения или текста' });
    
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    
    // Очищаем файлы в случае ошибки
    if (objectImage || backgroundImage) {
      cleanupFiles([
        objectImage?.path, 
        backgroundImage?.path
      ].filter(Boolean));
    }
    
    return res.status(500).json({ 
      error: `Ошибка при обработке: ${error.message}` 
    });
  }
});

// Маршрут для скачивания результата
app.get('/results/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'results', filename);
  
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).json({ error: 'Файл не найден' });
  }
});

// Функция для очистки файлов
function cleanupFiles(filePaths) {
  filePaths.forEach(filePath => {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.warn(`⚠️ Не удалось удалить файл: ${filePath}`, err.message);
      }
    }
  });
}

// Создаем необходимые директории
['public', 'uploads', 'results'].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📧 Откройте http://localhost:${PORT} в браузере`);
});
