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

// Функция для получения разрешения по качеству
function getResolution(quality) {
  const resolutions = {
    '1k': { width: 1024, height: 1024 },
    '2k': { width: 2048, height: 2048 },
    '4k': { width: 4096, height: 4096 }
  };
  return resolutions[quality] || resolutions['2k'];
}

// Функция для получения конфигурации по качеству
function getConfig(quality) {
  const qualityConfigs = {
    '1k': {
      thinkingConfig: {
        thinkingLevel: 'MEDIUM',
      },
      mediaResolution: 'MEDIA_RESOLUTION_LOW',
    },
    '2k': {
      thinkingConfig: {
        thinkingLevel: 'HIGH',
      },
      mediaResolution: 'MEDIA_RESOLUTION_HIGH',
    },
    '4k': {
      thinkingConfig: {
        thinkingLevel: 'HIGH',
      },
      mediaResolution: 'MEDIA_RESOLUTION_HIGH',
    }
  };
  return qualityConfigs[quality] || qualityConfigs['2k'];
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
    // Правильно читаем данные из FormData
    const { prompt, quality = '2k' } = req.body;
    
    console.log('📦 Полученные данные:');
    console.log('   prompt:', prompt);
    console.log('   quality:', quality);
    
    // Проверка наличия файлов
    if (!req.files || !req.files['objectImage'] || !req.files['backgroundImage']) {
      return res.status(400).json({ error: 'Оба изображения обязательны' });
    }
    
    objectImage = req.files['objectImage'][0];
    backgroundImage = req.files['backgroundImage'][0];

    console.log('🚀 Начинаем генерацию...');
    console.log('📷 Объект:', objectImage.filename);
    console.log('🏞️ Фон:', backgroundImage.filename);
    console.log('🎯 Качество:', quality);

    // Получаем конфигурацию по качеству
    const config = getConfig(quality);
    const model = 'gemini-3-pro-preview';

    const defaultPrompt = `
Create a photorealistic composite by perfectly integrating the object from the first image 
into the background scene from the second image.

CRITICAL REQUIREMENTS:
1. PRESERVE the object's original appearance, proportions, and details exactly as shown
2. Match LIGHTING conditions, color temperature, and light direction from the background scene
3. Apply physically accurate SHADOWS that match the light source in the background
4. Maintain proper PERSPECTIVE and scale relative to the background environment
5. Blend edges seamlessly with natural-looking integration
6. Adjust COLOR grading to match the background's atmosphere and mood
7. Add appropriate REFLECTIONS and ambient occlusion effects
8. Ensure perfect PHOTOREALISM with no visible seams or artificial edges

LIGHTING AND SHADOWS:
- Analyze the light direction in the background and match shadow direction accordingly
- Create soft, natural shadows with proper falloff
- Match shadow intensity and color with the background lighting
- Add contact shadows where the object touches surfaces

Return ONLY the final composite image with maximum realism and no text description.
    `;

    const finalPrompt = prompt || defaultPrompt;

    console.log('📝 Используется промт:', finalPrompt.substring(0, 200) + '...');

    // Подготовка содержимого
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
    
    const response = await ai.models.generateContent({
      model,
      config,
      contents,
    });

    console.log('✅ Запрос успешен!');

    // Обработка ответа
    if (response.candidates && response.candidates.length > 0) {
      const candidate = response.candidates[0];
      if (candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          if (part.inlineData) {
            const imageData = Buffer.from(part.inlineData.data, 'base64');
            
            // Сохраняем результат
            const resultDir = 'results/';
            if (!fs.existsSync(resultDir)) {
              fs.mkdirSync(resultDir, { recursive: true });
            }
            
            const timestamp = Date.now();
            const resolution = getResolution(quality);
            const filename = `result-${timestamp}-${quality}.png`;
            const filePath = path.join(resultDir, filename);
            
            // Обрабатываем изображение согласно выбранному качеству
            await sharp(imageData)
              .resize(resolution.width, resolution.height, {
                fit: 'inside',
                withoutEnlargement: true
              })
              .png({ quality: 100 })
              .toFile(filePath);
            
            console.log(`✅ Изображение сохранено: ${filename}`);
            console.log(`📐 Размер: ${resolution.width}x${resolution.height}`);
            
            // Очищаем временные файлы
            cleanupFiles([objectImage.path, backgroundImage.path]);
            
            return res.json({
              success: true,
              imageUrl: `/results/${filename}`,
              filename: filename,
              resolution: `${resolution.width}x${resolution.height}`
            });
          }
        }
      }
    }
    
    // Если нет изображения, проверяем текстовый ответ
    let fullText = '';
    if (response.candidates && response.candidates[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.text) {
          fullText += part.text;
        }
      }
    }
    
    if (fullText) {
      console.log('📝 Текстовый ответ:', fullText);
      return res.status(500).json({ 
        error: `API вернул текст вместо изображения: ${fullText.substring(0, 100)}...` 
      });
    }
    
    return res.status(500).json({ error: 'В ответе нет изображения или текста' });
    
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    console.error('Stack:', error.stack);
    
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

// Маршрут для быстрой генерации
app.post('/quick-generate', upload.fields([
  { name: 'objectImage', maxCount: 1 },
  { name: 'backgroundImage', maxCount: 1 }
]), async (req, res) => {
  let objectImage, backgroundImage;
  
  try {
    // Правильно читаем данные из FormData
    const { quality = '2k' } = req.body;
    
    console.log('⚡ Быстрая генерация - качество:', quality);
    
    if (!req.files || !req.files['objectImage'] || !req.files['backgroundImage']) {
      return res.status(400).json({ error: 'Оба изображения обязательны' });
    }
    
    objectImage = req.files['objectImage'][0];
    backgroundImage = req.files['backgroundImage'][0];

    const simplePrompt = "Put the object from first image into second image with realistic lighting and shadows. Make it photorealistic with perfect shadows and lighting matching. Return only the final composite image.";

    // Получаем конфигурацию по качеству
    const config = getConfig(quality);
    const model = 'gemini-3-pro-preview';

    const contents = [
      {
        role: 'user',
        parts: [
          { text: simplePrompt },
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

    const response = await ai.models.generateContent({
      model,
      config,
      contents,
    });

    if (response.candidates && response.candidates.length > 0) {
      const candidate = response.candidates[0];
      if (candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          if (part.inlineData) {
            const imageData = Buffer.from(part.inlineData.data, 'base64');
            
            const resultDir = 'results/';
            if (!fs.existsSync(resultDir)) {
              fs.mkdirSync(resultDir, { recursive: true });
            }
            
            const timestamp = Date.now();
            const resolution = getResolution(quality);
            const filename = `quick-result-${timestamp}-${quality}.png`;
            const filePath = path.join(resultDir, filename);
            
            await sharp(imageData)
              .resize(resolution.width, resolution.height, {
                fit: 'inside',
                withoutEnlargement: true
              })
              .png({ quality: 100 })
              .toFile(filePath);
            
            // Очищаем временные файлы
            cleanupFiles([objectImage.path, backgroundImage.path]);
            
            return res.json({
              success: true,
              imageUrl: `/results/${filename}`,
              filename: filename,
              resolution: `${resolution.width}x${resolution.height}`
            });
          }
        }
      }
    }
    
    return res.status(500).json({ error: 'Ошибка генерации' });
    
  } catch (error) {
    console.error('❌ Ошибка быстрой генерации:', error);
    
    if (objectImage || backgroundImage) {
      cleanupFiles([
        objectImage?.path, 
        backgroundImage?.path
      ].filter(Boolean));
    }
    
    return res.status(500).json({ error: error.message });
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
  console.log(`🤖 Используется модель: gemini-3-pro-preview`);
});
