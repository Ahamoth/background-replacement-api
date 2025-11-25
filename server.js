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

// Функция для создания запроса к Gemini API
function createGeminiRequest(objectImagePath, backgroundImagePath, promptText, quality) {
  const objectImageB64 = imageToBase64(objectImagePath);
  const backgroundImageB64 = imageToBase64(backgroundImagePath);

  return {
    contents: [
      {
        parts: [
          { text: promptText },
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
      temperature: 0.1,
      topP: 0.95,
      maxOutputTokens: 2048,
    }
  };
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

// Маршрут для обработки генерации
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

    console.log('🚀 Начинаем генерацию...');
    console.log('📷 Объект:', objectImage.filename);
    console.log('🏞️ Фон:', backgroundImage.filename);
    console.log('🎯 Качество:', quality);

    const API_KEY = process.env.GEMINI_API_KEY || "AIzaSyCkeDnvwpoxquYUKxCCXHO87UQO0U8ICwc";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${API_KEY}`;

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

    const requestBody = createGeminiRequest(
      objectImage.path,
      backgroundImage.path,
      finalPrompt,
      quality
    );

    const headers = {
      'Content-Type': 'application/json',
    };

    console.log('📡 Отправляем запрос к Gemini API...');
    
    const response = await axios.post(url, requestBody, { 
      headers, 
      timeout: 120000 
    });

    if (response.status === 200) {
      console.log('✅ Запрос успешен!');

      const result = response.data;
      
      if (result.candidates && result.candidates.length > 0) {
        const candidate = result.candidates[0];
        if (candidate.content && candidate.content.parts) {
          for (const part of candidate.content.parts) {
            if (part.inlineData) {
              const imageData = Buffer.from(part.inlineData.data, 'base64');
              
              // Сохраняем оригинальный результат
              const resultDir = 'results/';
              if (!fs.existsSync(resultDir)) {
                fs.mkdirSync(resultDir);
              }
              
              const timestamp = Date.now();
              const originalFilename = `result-${timestamp}.png`;
              const originalPath = path.join(resultDir, originalFilename);
              
              fs.writeFileSync(originalPath, imageData);
              
              // Обрабатываем изображение согласно выбранному качеству
              const resolution = getResolution(quality);
              const processedFilename = `result-${timestamp}-${quality}.png`;
              const processedPath = path.join(resultDir, processedFilename);
              
              await sharp(originalPath)
                .resize(resolution.width, resolution.height, {
                  fit: 'inside',
                  withoutEnlargement: true
                })
                .png({ quality: 100 })
                .toFile(processedPath);
              
              console.log(`✅ Изображение сохранено: ${processedFilename}`);
              console.log(`📐 Размер: ${resolution.width}x${resolution.height}`);
              
              // Очищаем временные файлы
              fs.unlinkSync(objectImage.path);
              fs.unlinkSync(backgroundImage.path);
              fs.unlinkSync(originalPath); // Удаляем временный файл
              
              return res.json({
                success: true,
                imageUrl: `/results/${processedFilename}`,
                filename: processedFilename,
                resolution: `${resolution.width}x${resolution.height}`
              });
            } else if (part.text) {
              console.log('📝 Текстовый ответ:', part.text);
            }
          }
        }
      }
      
      // Если нет inlineData, но есть текст - возвращаем ошибку с текстом
      if (result.candidates && result.candidates[0] && result.candidates[0].content) {
        const textParts = result.candidates[0].content.parts.filter(part => part.text);
        if (textParts.length > 0) {
          return res.status(500).json({ 
            error: `API вернул текст вместо изображения: ${textParts[0].text.substring(0, 200)}...` 
          });
        }
      }
      
      return res.status(500).json({ error: 'В ответе нет изображения' });
      
    } else {
      console.log('❌ Ошибка API:', response.status);
      console.log('Текст ошибки:', response.data);
      return res.status(response.status).json({ 
        error: `Ошибка API: ${response.status} - ${JSON.stringify(response.data)}` 
      });
    }
    
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    if (error.response) {
      console.error('Детали ошибки:', error.response.data);
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
  try {
    const { prompt, quality } = req.body;
    const objectImage = req.files['objectImage'][0];
    const backgroundImage = req.files['backgroundImage'][0];

    const simplePrompt = prompt || "Put the object from first image into second image with realistic lighting and shadows. Make it photorealistic with perfect shadows and lighting matching.";

    const API_KEY = process.env.GEMINI_API_KEY || "AIzaSyCkeDnvwpoxquYUKxCCXHO87UQO0U8ICwc";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${API_KEY}`;

    const requestBody = createGeminiRequest(
      objectImage.path,
      backgroundImage.path,
      simplePrompt,
      quality
    );

    console.log('⚡ Быстрая генерация...');
    const response = await axios.post(url, requestBody, { 
      timeout: 120000 
    });

    if (response.status === 200) {
      const result = response.data;
      
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
              const filename = `quick-result-${timestamp}-${quality}.png`;
              const filePath = path.join(resultDir, filename);
              
              await sharp(imageData)
                .resize(resolution.width, resolution.height, {
                  fit: 'inside',
                  withoutEnlargement: true
                })
                .png({ quality: 100 })
                .toFile(filePath);
              
              console.log(`✅ Быстрый результат сохранен: ${filename}`);
              console.log(`📐 Размер: ${resolution.width}x${resolution.height}`);
              
              // Очищаем временные файлы
              fs.unlinkSync(objectImage.path);
              fs.unlinkSync(backgroundImage.path);
              
              return res.json({
                success: true,
                imageUrl: `/results/${filename}`,
                filename: filename,
                resolution: `${resolution.width}x${resolution.height}`
              });
            } else if (part.text) {
              console.log('📝 Текстовый ответ (быстрая генерация):', part.text);
            }
          }
        }
      }
      
      // Если нет inlineData, но есть текст
      if (result.candidates && result.candidates[0] && result.candidates[0].content) {
        const textParts = result.candidates[0].content.parts.filter(part => part.text);
        if (textParts.length > 0) {
          return res.status(500).json({ 
            error: `API вернул текст вместо изображения: ${textParts[0].text.substring(0, 200)}...` 
          });
        }
      }
    }
    
    return res.status(500).json({ error: 'Ошибка генерации - нет изображения в ответе' });
    
  } catch (error) {
    console.error('❌ Ошибка быстрой генерации:', error.message);
    if (error.response) {
      console.error('Детали ошибки:', error.response.data);
    }
    
    if (req.files) {
      Object.values(req.files).forEach(fileArray => {
        fileArray.forEach(file => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
      });
    }
    
    return res.status(500).json({ error: error.message });
  }
});

// Новый маршрут для двухэтапной генерации (Gemini 2.5 Flash + Gemini 3 Pro)
app.post('/advanced-generate', upload.fields([
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

    console.log('🚀 Начинаем расширенную генерацию...');
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

Сгенерируй детальное, кинематографичное описание для создания фотореалистичного композита.

ОСНОВНЫЕ ТРЕБОВАНИЯ:
- Сохрани точные пропорции и детали объекта
- Проанализируй освещение и цветовую температуру фона
- Создай физически точные тени
- Сохрани перспективу и масштаб
- Обеспечь бесшовную интеграцию

ДОПОЛНИТЕЛЬНЫЕ УКАЗАНИЯ: ${prompt || "Сделай максимально фотореалистично"}

Верни ТОЛЬКО детальное текстовое описание для генерации изображения.`
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

    console.log('📝 Генерируем промт с помощью Gemini 2.5 Flash...');
    const flashResponse = await axios.post(flashUrl, promptGenerationBody, { timeout: 60000 });
    
    let generatedPrompt = prompt || defaultPrompt;
    
    if (flashResponse.status === 200 && flashResponse.data.candidates && flashResponse.data.candidates.length > 0) {
      const candidate = flashResponse.data.candidates[0];
      if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
        generatedPrompt = candidate.content.parts[0].text;
        console.log('✅ Промт успешно сгенерирован');
      }
    }

    console.log('📝 Используемый промт:', generatedPrompt.substring(0, 200) + '...');

    // Этап 2: Генерация изображения с помощью Gemini 3 Pro
    const proUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${API_KEY}`;

    const imageGenerationBody = {
      contents: [
        {
          parts: [
            { text: generatedPrompt }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        topP: 0.95,
        maxOutputTokens: 2048,
      }
    };

    console.log('🎨 Генерируем изображение с помощью Gemini 3 Pro...');
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
              const filename = `advanced-result-${timestamp}-${quality}.png`;
              const filePath = path.join(resultDir, filename);
              
              await sharp(imageData)
                .resize(resolution.width, resolution.height, {
                  fit: 'inside',
                  withoutEnlargement: false
                })
                .png({ quality: 100 })
                .toFile(filePath);
              
              console.log(`✅ Расширенный результат сохранен: ${filename}`);
              console.log(`📐 Размер: ${resolution.width}x${resolution.height}`);
              
              // Очищаем временные файлы
              fs.unlinkSync(objectImage.path);
              fs.unlinkSync(backgroundImage.path);
              
              return res.json({
                success: true,
                imageUrl: `/results/${filename}`,
                filename: filename,
                resolution: `${resolution.width}x${resolution.height}`,
                prompt: generatedPrompt.substring(0, 500) + '...'
              });
            }
          }
        }
      }
    }
    
    throw new Error('Не удалось сгенерировать изображение на втором этапе');
    
  } catch (error) {
    console.error('❌ Ошибка расширенной генерации:', error.message);
    
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
      error: `Ошибка при расширенной генерации: ${error.message}` 
    });
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
});
