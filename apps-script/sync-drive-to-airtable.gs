/**
 * Drive → Airtable FOTOS sync
 * Watches the pool folder and creates a FOTOS record for each new file.
 * Run on a 5-minute time-based trigger.
 *
 * Determina automáticamente:
 *  - Tipo: Video si extensión MP4/MOV/M4V/WEBM/MKV/AVI, sino Foto
 *  - Estado: Activa
 *  - Total Usos: 0
 *  - Engagement Score: 3 (default — ajusta manualmente si una foto es excepcional)
 *  - Fecha Añadida: hoy
 *  - URL Drive: webViewLink
 *  - Nombre: nombre del archivo sin extensión
 */

// ── CONFIG ──────────────────────────────────────────────────────────────────
const POOL_FOLDER_ID = '1azvpmtMcWviYKWc7BtIWlMOcNgMrdRae';
const AIRTABLE_BASE = 'appeqyvYmqKgXeOSW';
const AIRTABLE_TABLE_FOTOS = 'tbliFstlSbfAOYLg0';
// El token se guarda en Script Properties (Configuración del proyecto → Propiedades del script)
// Clave: AIRTABLE_TOKEN
const AIRTABLE_TOKEN = PropertiesService.getScriptProperties().getProperty('AIRTABLE_TOKEN');

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mpg', 'mpeg'];
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'tiff'];

// ── MAIN ────────────────────────────────────────────────────────────────────
function syncDriveToAirtable() {
  if (!AIRTABLE_TOKEN) {
    throw new Error('Falta AIRTABLE_TOKEN en Script Properties. Configúralo en Project Settings → Script properties.');
  }

  const folder = DriveApp.getFolderById(POOL_FOLDER_ID);
  const files = folder.getFiles();

  // Obtener URLs ya existentes en Airtable para no duplicar
  const existingUrls = getExistingDriveUrls();
  Logger.log(`URLs existentes en Airtable: ${existingUrls.size}`);

  let created = 0;
  let skipped = 0;
  while (files.hasNext()) {
    const file = files.next();
    const url = file.getUrl();

    if (existingUrls.has(url)) {
      skipped++;
      continue;
    }

    try {
      createFotoRecord(file);
      created++;
      Logger.log(`✓ Creado: ${file.getName()}`);
    } catch (e) {
      Logger.log(`✗ Error creando ${file.getName()}: ${e.message}`);
    }
  }

  Logger.log(`Done — created: ${created}, skipped: ${skipped}`);
  return { created, skipped };
}

// ── HELPERS ─────────────────────────────────────────────────────────────────
function getExistingDriveUrls() {
  const urls = new Set();
  let offset = null;
  do {
    const params = ['fields%5B%5D=URL%20Drive', 'pageSize=100'];
    if (offset) params.push('offset=' + encodeURIComponent(offset));
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE_FOTOS}?${params.join('&')}`;
    const resp = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + AIRTABLE_TOKEN },
      muteHttpExceptions: true
    });
    const data = JSON.parse(resp.getContentText());
    if (resp.getResponseCode() !== 200) throw new Error('Airtable list failed: ' + resp.getContentText());
    (data.records || []).forEach(r => {
      const u = r.fields && r.fields['URL Drive'];
      if (u) urls.add(u);
    });
    offset = data.offset;
  } while (offset);
  return urls;
}

function createFotoRecord(file) {
  const name = file.getName();
  const dot = name.lastIndexOf('.');
  const baseName = dot > 0 ? name.substring(0, dot) : name;
  const ext = dot > 0 ? name.substring(dot + 1).toLowerCase() : '';

  let tipo = 'Foto';
  if (VIDEO_EXTENSIONS.includes(ext)) tipo = 'Video';
  else if (!IMAGE_EXTENSIONS.includes(ext)) {
    // Fallback: usar MIME type
    const mime = file.getMimeType() || '';
    if (mime.startsWith('video/')) tipo = 'Video';
  }

  const today = Utilities.formatDate(new Date(), 'America/Santo_Domingo', 'yyyy-MM-dd');

  const fields = {
    'Nombre': baseName,
    'URL Drive': file.getUrl(),
    'Tipo': tipo,
    'Engagement Score': 3,
    'Total Usos': 0,
    'Estado': 'Activa',
    'Fecha Añadida': today
  };

  const resp = UrlFetchApp.fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE_FOTOS}`,
    {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + AIRTABLE_TOKEN },
      payload: JSON.stringify({ fields, typecast: true }),
      muteHttpExceptions: true
    }
  );
  if (resp.getResponseCode() !== 200) {
    throw new Error(`Airtable create failed (${resp.getResponseCode()}): ${resp.getContentText()}`);
  }
}

// ── SETUP HELPERS ───────────────────────────────────────────────────────────
// Ejecuta esta función UNA VEZ desde el editor de Apps Script para crear el trigger
function installTrigger() {
  // Limpiar triggers viejos
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  // Crear trigger cada 5 minutos
  ScriptApp.newTrigger('syncDriveToAirtable')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('Trigger instalado: syncDriveToAirtable cada 5 minutos');
}

// Test manual
function testRun() {
  const result = syncDriveToAirtable();
  Logger.log(JSON.stringify(result));
}
