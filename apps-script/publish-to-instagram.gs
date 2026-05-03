/**
 * Instagram Publisher — POSTS Aprobado → publica carrusel en IG → actualiza Airtable
 *
 * Vigila la tabla POSTS cada 5 min. Cuando un post tiene Estado=Aprobado:
 *  1. Lee Fotos IDs en orden
 *  2. Auto-configura las fotos del Drive como públicas (necesario para IG)
 *  3. Crea media items en Instagram (imagen o video)
 *  4. Espera a que los videos terminen de procesar
 *  5. Crea carousel container con caption
 *  6. Publica
 *  7. Actualiza POSTS → Estado=Publicado, Instagram Post ID, Fecha Publicación
 *  8. Por cada foto usada: crea registro en USOS, actualiza Total Usos/Última Vez Usada/Último Slide/Último Post ID
 *
 * Si algo falla → POSTS.Estado = "Rechazado" con razón en el caption (revisar log para detalles).
 *
 * Setup en Script Properties (Settings → Script properties):
 *   AIRTABLE_TOKEN          — pat... (mismo del sync)
 *   IG_PAGE_ACCESS_TOKEN    — EAA... long-lived page token (60 días)
 *   IG_USER_ID              — 17841477275575181
 */

// ── CONFIG ──────────────────────────────────────────────────────────────────
const AIRTABLE_BASE   = 'appeqyvYmqKgXeOSW';
const TABLE_FOTOS     = 'tbliFstlSbfAOYLg0';
const TABLE_POSTS     = 'tblYWMeWVwFwWhHpo';
const TABLE_USOS      = 'tblLBjfaGBFz7uQWT';
const IG_API_VERSION  = 'v19.0';
const VIDEO_POLL_INTERVAL_MS = 6000;
const VIDEO_POLL_MAX_ATTEMPTS = 50;

// Field IDs en POSTS (para PATCH preciso)
const F_TITULO          = 'flduleH1l75CsbLYR';
const F_ESTADO          = 'fldZFQTDswbPlbUXS';
const F_CAPTION         = 'fldgBPTYscHwC7DRF';
const F_CANT_SLIDES     = 'fldDG6kTLDzCCCrcW';
const F_FOTOS_IDS       = 'fldPaDrmIMTZyvOTR';
const F_IG_POST_ID      = 'fld4ZUIk9CbmLylXF';
const F_FECHA_PUB       = 'fldmtZaqskaCDpApq';

// Puntuación por slide
const POINTS_BY_SLIDE = { 1: 10, 2: 7, 3: 5 };
const POINTS_DEFAULT  = 3;
const POINTS_BONUS_PER_REPEAT = 2;

// ── ENTRY ───────────────────────────────────────────────────────────────────
function publishApprovedPosts() {
  const tokens = getTokens();
  const aprobados = findAprobados(tokens.airtable);
  Logger.log(`POSTS Aprobado encontrados: ${aprobados.length}`);
  let published = 0;
  for (const post of aprobados) {
    try {
      processPost(post, tokens);
      published++;
    } catch (e) {
      Logger.log(`✗ Error con ${post.id}: ${e.message}`);
      markPostError(post.id, e.message, tokens.airtable);
    }
  }
  Logger.log(`Done — published: ${published}`);
}

// ── TOKENS ──────────────────────────────────────────────────────────────────
function getTokens() {
  const props = PropertiesService.getScriptProperties();
  const t = {
    airtable: props.getProperty('AIRTABLE_TOKEN'),
    igToken:  props.getProperty('IG_PAGE_ACCESS_TOKEN'),
    igUserId: props.getProperty('IG_USER_ID')
  };
  if (!t.airtable) throw new Error('Falta AIRTABLE_TOKEN en Script Properties');
  if (!t.igToken)  throw new Error('Falta IG_PAGE_ACCESS_TOKEN en Script Properties');
  if (!t.igUserId) throw new Error('Falta IG_USER_ID en Script Properties');
  return t;
}

// ── POSTS QUERIES ───────────────────────────────────────────────────────────
function findAprobados(token) {
  const formula = encodeURIComponent("{Estado} = 'Aprobado'");
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_POSTS}?filterByFormula=${formula}&maxRecords=10`;
  const resp = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true
  });
  const data = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() !== 200) throw new Error('Airtable list aprobados: ' + resp.getContentText());
  return data.records || [];
}

function getFotoById(fotoId, token) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_FOTOS}/${fotoId}`;
  const resp = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) throw new Error(`No se pudo leer foto ${fotoId}: ${resp.getContentText()}`);
  return JSON.parse(resp.getContentText());
}

function patchAirtable(table, recordId, fields, token) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}/${recordId}`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'patch',
    headers: { 'Authorization': 'Bearer ' + token },
    contentType: 'application/json',
    payload: JSON.stringify({ fields }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) throw new Error(`Airtable PATCH ${table}/${recordId} failed: ${resp.getContentText()}`);
  return JSON.parse(resp.getContentText());
}

function createAirtableRecord(table, fields, token) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + token },
    contentType: 'application/json',
    payload: JSON.stringify({ fields, typecast: true }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) throw new Error(`Airtable POST ${table} failed: ${resp.getContentText()}`);
  return JSON.parse(resp.getContentText());
}

// ── DRIVE → IG URL ──────────────────────────────────────────────────────────
function extractDriveFileId(driveUrl) {
  if (!driveUrl) return null;
  let m = driveUrl.match(/\/file\/d\/([^/]+)/);
  if (m) return m[1];
  m = driveUrl.match(/[?&]id=([^&]+)/);
  return m ? m[1] : null;
}

function ensureDrivePublic(fileId) {
  try {
    const file = DriveApp.getFileById(fileId);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    Logger.log(`⚠ No se pudo cambiar sharing de ${fileId}: ${e.message}`);
  }
}

function imageUrlForIG(driveUrl) {
  const id = extractDriveFileId(driveUrl);
  if (!id) throw new Error('No se pudo extraer file ID de: ' + driveUrl);
  ensureDrivePublic(id);
  return `https://lh3.googleusercontent.com/d/${id}=s2048`;
}

function videoUrlForIG(driveUrl) {
  const id = extractDriveFileId(driveUrl);
  if (!id) throw new Error('No se pudo extraer file ID de: ' + driveUrl);
  ensureDrivePublic(id);
  // Para videos, lh3 también sirve pero a veces falla; usamos endpoint directo de Drive
  return `https://drive.google.com/uc?export=download&id=${id}`;
}

// ── INSTAGRAM API ───────────────────────────────────────────────────────────
function igPost(path, params, igToken) {
  const url = `https://graph.facebook.com/${IG_API_VERSION}/${path}`;
  const formData = Object.assign({ access_token: igToken }, params);
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    payload: formData,
    muteHttpExceptions: true
  });
  const body = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() !== 200 || body.error) {
    throw new Error(`IG ${path} failed: ${JSON.stringify(body.error || body)}`);
  }
  return body;
}

function igGet(path, params, igToken) {
  const qs = Object.entries(Object.assign({ access_token: igToken }, params))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const url = `https://graph.facebook.com/${IG_API_VERSION}/${path}?${qs}`;
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const body = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() !== 200 || body.error) {
    throw new Error(`IG GET ${path} failed: ${JSON.stringify(body.error || body)}`);
  }
  return body;
}

function createIGMediaItem(igUserId, foto, igToken) {
  const tipo = foto.fields.Tipo || 'Foto';
  const driveUrl = foto.fields['URL Drive'];
  if (tipo === 'Video') {
    const result = igPost(`${igUserId}/media`, {
      media_type: 'VIDEO',
      video_url: videoUrlForIG(driveUrl),
      is_carousel_item: true
    }, igToken);
    // Esperar a que el video termine de procesar
    waitForVideoReady(result.id, igToken);
    return result.id;
  } else {
    const result = igPost(`${igUserId}/media`, {
      image_url: imageUrlForIG(driveUrl),
      is_carousel_item: true
    }, igToken);
    return result.id;
  }
}

function waitForVideoReady(mediaId, igToken) {
  for (let i = 0; i < VIDEO_POLL_MAX_ATTEMPTS; i++) {
    Utilities.sleep(VIDEO_POLL_INTERVAL_MS);
    const status = igGet(mediaId, { fields: 'status_code' }, igToken);
    Logger.log(`Video ${mediaId} status: ${status.status_code}`);
    if (status.status_code === 'FINISHED') return;
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      throw new Error(`Video ${mediaId} falló procesamiento: ${status.status_code}`);
    }
  }
  throw new Error(`Timeout esperando video ${mediaId}`);
}

function createCarouselAndPublish(igUserId, mediaIds, caption, igToken) {
  // 1. Container
  const container = igPost(`${igUserId}/media`, {
    media_type: 'CAROUSEL',
    children: mediaIds.join(','),
    caption: caption
  }, igToken);

  // 2. Publish
  const published = igPost(`${igUserId}/media_publish`, {
    creation_id: container.id
  }, igToken);

  return published.id;  // IG Post ID
}

// ── MAIN PIPELINE ───────────────────────────────────────────────────────────
function processPost(post, tokens) {
  const fields = post.fields;
  const fotoIds = (fields['Fotos IDs'] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (fotoIds.length < 2) throw new Error(`Carrusel requiere ≥2 items, tiene ${fotoIds.length}`);
  if (fotoIds.length > 10) throw new Error(`Carrusel máx 10 items, tiene ${fotoIds.length}`);

  const caption = (fields['Caption'] || '').replace(/\s\|\s/g, '\n\n');  // | → saltos para IG
  Logger.log(`Publicando ${post.id} con ${fotoIds.length} slides`);

  // 1. Crear media items en orden
  const mediaIds = [];
  const fotoData = [];
  for (let i = 0; i < fotoIds.length; i++) {
    const foto = getFotoById(fotoIds[i], tokens.airtable);
    fotoData.push(foto);
    Logger.log(`  Slide ${i+1}: ${foto.fields.Nombre} (${foto.fields.Tipo || 'Foto'})`);
    const mediaId = createIGMediaItem(tokens.igUserId, foto, tokens.igToken);
    mediaIds.push(mediaId);
  }

  // 2. Crear carrusel y publicar
  const igPostId = createCarouselAndPublish(tokens.igUserId, mediaIds, caption, tokens.igToken);
  Logger.log(`✓ Publicado: IG post ${igPostId}`);

  // 3. Update POSTS
  const today = Utilities.formatDate(new Date(), 'America/Santo_Domingo', 'yyyy-MM-dd');
  patchAirtable(TABLE_POSTS, post.id, {
    [F_ESTADO]: 'Publicado',
    [F_IG_POST_ID]: igPostId,
    [F_FECHA_PUB]: today
  }, tokens.airtable);

  // 4. Update fotos + create USOS
  for (let i = 0; i < fotoData.length; i++) {
    const foto = fotoData[i];
    const slideNum = i + 1;
    const prevUsos = foto.fields['Total Usos'] || 0;
    const basePoints = POINTS_BY_SLIDE[slideNum] || POINTS_DEFAULT;
    const points = basePoints + (prevUsos * POINTS_BONUS_PER_REPEAT);

    // Update foto
    patchAirtable(TABLE_FOTOS, foto.id, {
      'Total Usos': prevUsos + 1,
      'Última Vez Usada': today,
      'Último Slide': slideNum,
      'Último Post ID': igPostId
    }, tokens.airtable);

    // Create USOS
    createAirtableRecord(TABLE_USOS, {
      'Foto': [foto.id],
      'Post': [post.id],
      'Número de Slide': slideNum,
      'Fecha': today,
      'Puntos Asignados': points
    }, tokens.airtable);

    Logger.log(`  Foto ${foto.fields.Nombre}: slide ${slideNum}, +${points} pts`);
  }
}

function markPostError(postId, errorMsg, airtableToken) {
  try {
    patchAirtable(TABLE_POSTS, postId, {
      [F_ESTADO]: 'Rechazado',
      [F_CAPTION]: '❌ ERROR PUBLICACIÓN: ' + errorMsg.substring(0, 500)
    }, airtableToken);
  } catch (e) {
    Logger.log(`No se pudo marcar error en ${postId}: ${e.message}`);
  }
}

// ── SETUP ───────────────────────────────────────────────────────────────────
function installPublisherTrigger() {
  const existing = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'publishApprovedPosts');
  existing.forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('publishApprovedPosts')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('Trigger instalado: publishApprovedPosts cada 5 minutos');
}

function testPublishRun() {
  publishApprovedPosts();
}

// ── TOKEN REFRESH HELPER (correr manualmente cada ~50 días) ─────────────────
function refreshIGToken() {
  const props = PropertiesService.getScriptProperties();
  const currentToken = props.getProperty('IG_PAGE_ACCESS_TOKEN');
  const url = `https://graph.facebook.com/${IG_API_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=892843180487713&client_secret=${props.getProperty('META_APP_SECRET')}&fb_exchange_token=${currentToken}`;
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(resp.getContentText());
  if (data.access_token) {
    props.setProperty('IG_PAGE_ACCESS_TOKEN', data.access_token);
    Logger.log('Token refrescado. Expira en: ' + (data.expires_in / 86400) + ' días');
  } else {
    Logger.log('Error: ' + JSON.stringify(data));
  }
}
