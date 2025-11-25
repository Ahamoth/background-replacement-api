const express = require('express');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
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

// Функция для конвертации изображения в base64
function imageToBase64(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  return imageBuffer.toString('base64');
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

// Основной маршрут
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Единственный маршрут для двухэтапной генерации (Gemini 2.5 Flash + Gemini 3 Pro)
app.post('/generate', upload.fields([
  { name: 'objectImage', maxCount: 1 },
  { name: 'backgroundImage', maxCount: 1 }
]), async (req, res) => {
  try {
    const { prompt, quality } = req.body;
    const objectImage = req.files['objectImage'][0];
    const backgroundImage = req.files['backgroundImage'][0];

    if (!objectImage || !backgroundImage) {
      return res.status(400).json({ error: 'Оба изображения обязательны' });
    }

    console.log('🚀 Начинаем двухэтапную генерацию...');
    console.log('📷 Объект:', objectImage.filename);
    console.log('🏞️ Фон:', backgroundImage.filename);
    console.log('🎯 Качество:', quality);

    const API_KEY = process.env.GEMINI_API_KEY;

    // Этап 1: Генерация промта с помощью Gemini 2.5 Flash
    const flashUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;
    
    const objectImageB64 = imageToBase64(objectImage.path);
    const backgroundImageB64 = imageToBase64(backgroundImage.path);

    const promptGenerationBody = {
      contents: [
        {
          parts: [
            {
              text: `ПРОАНАЛИЗИРУЙ два изображения:
1. Первое изображение - ОБЪЕКТ для вставки
2. Второе изображение - ФОНОВАЯ СЦЕНА

Сгенерируй детальное, кинематографичное описание для создания фотореалистичного композита, где объект из первого изображения идеально интегрирован во второе изображение.

КРИТИЧЕСКИЕ ТРЕБОВАНИЯ:
1. СОХРАНИ оригинальный внешний вид, пропорции и детали объекта точно как показано
2. СОВМЕСТИ условия ОСВЕЩЕНИЯ, цветовую температуру и направление света с фоновой сценой
3. ПРИМЕНИ физически точные ТЕНИ, соответствующие источнику света в фоне
4. СОХРАНИ правильную ПЕРСПЕКТИВУ и масштаб относительно фоновой среды
5. СМЕШАЙ края бесшовно с естественной интеграцией
6. НАСТРОЙ цветовую градацию в соответствии с атмосферой и настроением фона
7. ДОБАВЬ соответствующие ОТРАЖЕНИЯ и эффекты окружающего затенения
8. ОБЕСПЕЧЬ идеальный ФОТОРЕАЛИЗМ без видимых швов или искусственных краев

ОСВЕЩЕНИЕ И ТЕНИ:
- Проанализируй направление света в фоне и соответственно сопоставь направление теней
- Создай мягкие, естественные тени с правильным спадом
- Сопоставь интенсивность и цвет теней с освещением фона
- Добавь контактные тени там, где объект касается поверхностей

ДОПОЛНИТЕЛЬНЫЕ УКАЗАНИЯ ПОЛЬЗОВАТЕЛЯ: ${prompt || "Сделай максимально фотореалистично с кинематографичным качеством"}

Верни ТОЛЬКО детальное текстовое описание для генерации изображения, без дополнительных комментариев.`
            },
            {
              inline_data: {
                mime_type: "image/jpeg",
                data: objectImageB64
              }
            },
            {
              inline_data: {
                mime_type: "image/jpeg",
                data: backgroundImageB64
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.3,
        topP: 0.95,
        maxOutputTokens: 2048,
      }
    };

    console.log('📝 Этап 1: Генерируем промт с помощью Gemini 2.5 Flash...');
    const flashResponse = await axios.post(flashUrl, promptGenerationBody, { timeout: 60000 });
    
    let generatedPrompt;
    
    if (flashResponse.status === 200 && flashResponse.data.candidates && flashResponse.data.candidates.length > 0) {
      const candidate = flashResponse.data.candidates[0];
      if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
        generatedPrompt = candidate.content.parts[0].text;
        console.log('✅ Промт успешно сгенерирован!');
        console.log('📝 Длина промта:', generatedPrompt.length, 'символов');
      } else {
        throw new Error('Не удалось извлечь сгенерированный промт из ответа');
      }
    } else {
      throw new Error('Ошибка при генерации промта: ' + JSON.stringify(flashResponse.data));
    }

    console.log('📝 Сгенерированный промт:', generatedPrompt.substring(0, 200) + '...');

    // Этап 2: Генерация изображения с помощью Gemini 3 Pro
    const proUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${API_KEY}`;

    const imageGenerationBody = {
      contents: [
        {
          parts: [
            { 
              text: `${generatedPrompt}

ТЕХНИЧЕСКИЕ ТРЕБОВАНИЯ ДЛЯ ИЗОБРАЖЕНИЯ:
- Создай фотореалистичное изображение в ВЫСОКОМ РАЗРЕШЕНИИ
- Используй профессиональную цветокоррекцию и естественное освещение
- Обеспечь ЧЕТКИЕ ДЕТАЛИ и реалистичные текстуры
- Добейся КИНЕМАТОГРАФИЧНОГО КАЧЕСТВА
- Верни ТОЛЬКО финальное изображение без текстового описания`
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        topP: 0.95,
        maxOutputTokens: 2048,
      }
    };

    console.log('🎨 Этап 2: Генерируем изображение с помощью Gemini 3 Pro...');
    const proResponse = await axios.post(proUrl, imageGenerationBody, { timeout: 120000 });

    if (proResponse.status === 200) {
      const result = proResponse.data;
      
      if (result.candidates && result.candidates.length > 0) {
        const candidate = result.candidates[0];
        if (candidate.content && candidate.content.parts) {
          for (const part of candidate.content.parts) {
            if (part.inlineData) {
              const imageData = Buffer.from(part.inlineData.data, 'base64');
              
              const resultDir = 'results/';
              if (!fs.existsSync(resultDir)) {
                fs.mkdirSync(resultDir);
              }
              
              const timestamp = Date.now();
              const resolution = getResolution(quality);
              const filename = `result-${timestamp}-${quality}.png`;
              const filePath = path.join(resultDir, filename);
              
              // Сохраняем и обрабатываем изображение
              await sharp(imageData)
                .resize(resolution.width, resolution.height, {
                  fit: 'inside',
                  withoutEnlargement: false
                })
                .png({ quality: 100 })
                .toFile(filePath);
              
              console.log(`✅ Изображение успешно создано: ${filename}`);
              console.log(`📐 Разрешение: ${resolution.width}x${resolution.height}`);
              
              // Очищаем временные файлы
              fs.unlinkSync(objectImage.path);
              fs.unlinkSync(backgroundImage.path);
              
              // Сохраняем сгенерированный промт для отладки
              const promptFilename = `prompt-${timestamp}.txt`;
              fs.writeFileSync(path.join(resultDir, promptFilename), generatedPrompt);
              
              return res.json({
                success: true,
                imageUrl: `/results/${filename}`,
                filename: filename,
                resolution: `${resolution.width}x${resolution.height}`,
                promptPreview: generatedPrompt.substring(0, 300) + '...',
                promptLength: generatedPrompt.length
              });
            }
          }
        }
      }
      
      // Если нет изображения в ответе
      return res.status(500).json({ 
        error: 'Gemini 3 Pro не вернул изображение в ответе',
        details: JSON.stringify(result)
      });
    } else {
      throw new Error(`Ошибка Gemini 3 Pro: ${proResponse.status} - ${JSON.stringify(proResponse.data)}`);
    }
    
  } catch (error) {
    console.error('❌ Ошибка в процессе генерации:', error.message);
    
    if (error.response) {
      console.error('Детали ошибки API:', error.response.data);
    }
    
    // Очищаем файлы в случае ошибки
    if (req.files) {
      Object.values(req.files).forEach(fileArray => {
        fileArray.forEach(file => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
      });
    }
    
    return res.status(500).json({ 
      error: `Ошибка при генерации: ${error.message}`,
      details: error.response ? error.response.data : null
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

// Маршрут для получения информации о сгенерированном промте
app.get('/prompt/:timestamp', (req, res) => {
  const timestamp = req.params.timestamp;
  const promptPath = path.join(__dirname, 'results', `prompt-${timestamp}.txt`);
  
  if (fs.existsSync(promptPath)) {
    const promptText = fs.readFileSync(promptPath, 'utf8');
    res.json({ prompt: promptText });
  } else {
    res.status(404).json({ error: 'Промт не найден' });
  }
});

// Создаем необходимые директории
['public', 'uploads', 'results'].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📧 Откройте http://localhost:${PORT} в браузере`);
  console.log('🎯 Доступные качества: 1K, 2K, 4K');
  console.log('🔑 API ключ:', process.env.GEMINI_API_KEY ? 'из переменных окружения' : 'по умолчанию');
});
