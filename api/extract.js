import Tesseract from 'tesseract.js';
import Jimp from 'jimp';
import jsQR from 'jsqr';

// El body puede pesar unos megas (imagen en base64) — ver nota de límites
// de Vercel al final del mensaje.
export const config = {
  api: { bodyParser: { sizeLimit: '8mb' } }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const { image } = req.body || {};
  if (!image) {
    res.status(400).json({ error: 'Falta la imagen' });
    return;
  }

  try {
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');

    // 1) Intentar leer el código QR (si el documento trae uno, como la
    //    constancia de situación fiscal).
    let qr = { rfc: null, idcif: null };
    try {
      const img = await Jimp.read(buffer);
      const { data, width, height } = img.bitmap;
      const code = jsQR(new Uint8ClampedArray(data), width, height);
      if (code) qr = extractFromQrUrl(code.data);
    } catch (e) {
      // si falla la lectura del QR seguimos solo con el texto
    }

    // 2) OCR del texto completo del documento
    const { data: { text } } = await Tesseract.recognize(buffer, 'spa');
    const parsed = parseText(text);

    res.status(200).json({
      tipoDocumento: parsed.tipo,
      curp: parsed.curp || '',
      nombre: parsed.nombre || '',
      rfc: parsed.rfc || qr.rfc || '',
      idcif: parsed.idcif || qr.idcif || '',
      fuenteRfc: parsed.rfc ? 'texto' : (qr.rfc ? 'qr' : null),
      fuenteIdcif: parsed.idcif ? 'texto' : (qr.idcif ? 'qr' : null)
    });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo procesar el documento', detalle: String(err) });
  }
}

// La URL real del QR de la constancia fiscal tiene esta forma:
// https://siat.sat.gob.mx/.../validadorqr.jsf?D1=10&D2=1&D3=21020119603_CUDG011028F61
// D3 trae "idCIF_RFC" separados por guion bajo.
function extractFromQrUrl(str) {
  let rfc = null, idcif = null;
  try {
    const url = new URL(str);
    const d3 = url.searchParams.get('D3');
    if (d3 && d3.includes('_')) {
      const [id, r] = d3.split('_');
      idcif = id || null;
      rfc = r || null;
    }
  } catch (e) {
    // no era una URL válida
  }
  if (!rfc) {
    const m = str.match(/[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}/i);
    if (m) rfc = m[0].toUpperCase();
  }
  return { rfc, idcif };
}

function labelValue(text, label) {
  const re = new RegExp(label + '[:\\s]+([^\\n]+)', 'i');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function parseText(rawText) {
  const text = rawText.replace(/\r/g, '');
  const upper = text.toUpperCase();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // --- Detectar tipo de documento ---
  let tipo = 'desconocido';
  if (upper.includes('CONSTANCIA DE SITUACION FISCAL') || upper.includes('CEDULA DE IDENTIFICACION FISCAL')) {
    tipo = 'fiscal';
  } else if (upper.includes('INSTITUTO NACIONAL ELECTORAL') || upper.includes('CREDENCIAL PARA VOTAR')) {
    tipo = 'ine_frente';
  } else if (lines.some(l => /^[A-Z<]{20,}$/.test(l.toUpperCase()) && l.includes('<<'))) {
    tipo = 'ine_reverso';
  }

  let curp = null, rfc = null, idcif = null, nombre = null;

  // --- Constancia de situación fiscal: extracción por etiqueta ---
  if (tipo === 'fiscal') {
    rfc = labelValue(text, 'RFC');
    curp = labelValue(text, 'CURP');
    idcif = labelValue(text, 'idCIF');
    const nombres = labelValue(text, 'Nombre \\(s\\)') || labelValue(text, 'Nombre');
    const apPaterno = labelValue(text, 'Primer Apellido');
    const apMaterno = labelValue(text, 'Segundo Apellido');
    nombre = [apPaterno, apMaterno, nombres].filter(Boolean).join(' ') || null;
  }

  // --- Reverso de INE: zona de lectura mecánica (MRZ) ---
  if (tipo === 'ine_reverso') {
    const mrzLine = lines.find(l => /^[A-Z<]{20,}$/.test(l.toUpperCase()) && l.includes('<<'));
    if (mrzLine) {
      const parts = mrzLine.toUpperCase().split('<<').filter(Boolean);
      const surnames = (parts[0] || '').replace(/</g, ' ').trim();
      const given = (parts[1] || '').replace(/</g, ' ').trim();
      nombre = `${surnames} ${given}`.replace(/\s+/g, ' ').trim() || null;
    }
  }

  // --- Frente de INE: nombre en 3 líneas debajo de la etiqueta NOMBRE ---
  if (tipo === 'ine_frente') {
    const nameIdx = lines.findIndex(l => l.toUpperCase().includes('NOMBRE'));
    if (nameIdx !== -1) {
      const stopWords = ['DOMICILIO', 'FECHA', 'SEXO', 'CURP', 'CLAVE', 'AÑO', 'REGISTRO', 'ENTIDAD', 'MUNICIPIO'];
      const nameLines = [];
      for (let i = nameIdx + 1; i < lines.length && nameLines.length < 3; i++) {
        if (stopWords.some(w => lines[i].toUpperCase().includes(w))) break;
        if (lines[i].length > 1) nameLines.push(lines[i]);
      }
      nombre = nameLines.join(' ').replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ\s]/g, '').replace(/\s+/g, ' ').trim() || null;
    }
  }

  // --- Respaldo genérico por patrón, para cualquier tipo de documento ---
  if (!curp) {
    const m = upper.match(/[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d/);
    if (m) curp = m[0];
  }
  if (!rfc) {
    const m = upper.match(/[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}/);
    if (m) rfc = m[0];
  }
  if (!idcif) {
    const m = text.match(/id\s?cif[:\s]*([0-9A-Za-z]{4,})/i);
    if (m) idcif = m[1];
  }

  return { curp, rfc, idcif, nombre, tipo };
}
