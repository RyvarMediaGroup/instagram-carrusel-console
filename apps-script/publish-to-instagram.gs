/**
 * Instagram Publisher (Instagram Login API) — POSTS Aprobado → publica → actualiza Airtable
 *
 * Usa Instagram Login API directa (graph.instagram.com), NO Facebook Pages.
 * Vigila POSTS Estado=Aprobado cada 5 min y publica el carrusel.
 *
 * Setup en Script Properties:
 *   AIRTABLE_TOKEN          — pat... (mismo del sync)
 *   IG_ACCESS_TOKEN         — IGAAN... long-lived token (60 días, refrescable)
 *   IG_USER_ID              — 26817524484605499 (Instagram Login user ID)
 */

// ── CONFIG ──────────────────────────────────────────────────────────────────
// AIRTABLE_BASE y AIRTABLE_TABLE_FOTOS ya declarados en sync-drive-to-airtable.gs
const TABLE_FOTOS     = 'tbliFstlSbfAOYLg0';  // mismo valor que AIRTABLE_TABLE_FOTOS, alias local
const TABLE_POSTS     = 'tblYWMeWVwFwWhHpo';
const TABLE_USOS      = 'tblLBjfaGBFz7uQWT';
const IG_API_BASE     = 'https://graph.instagram.com/v22.0';
const VIDEO_POLL_INTERVAL_MS = 6000;
const VIDEO_POLL_MAX_ATTEMPTS = 50;

// Field IDs
const F_TITULO      = 'flduleH1l75CsbLYR';
const F_ESTADO      = 'fldZFQTDswbPlbUXS';
const F_CAPTION     = 'fldgBPTYscHwC7DRF';
const F_FOTOS_IDS   = 'fldPaDrmIMTZyvOTR';
const F_IG_POST_ID  = 'fld4ZUIk9CbmLylXF';
const F_FECHA_PUB   = 'fldmtZaqskaCDpApq';

const POINTS_BY_SLIDE = { 1: 10, 2: 7, 3: 5 };
const POINTS_DEFAULT  = 3;
const POINTS_BONUS_PER_REPEAT = 2;

// ── ENTRY ───────────────────────────────────────────────────────────────────
function publishApprovedPosts() {
  const tokens = getTokens();
  const aprobados = findAprobados(tokens.airtable);
  Logger.log(`POSTS Aprobado: ${aprobados.length}`);
  let published = 0;
  for (const post of aprobados) {
    try {
      processPost(post, tokens);
      published++;
    } catch (e) {
      Logger.log(`✗ ${post.id}: ${e.message}`);
      markPostError(post.id, e.message, tokens.airtable);
    }
  }
  Logger.log(`Done — published: ${published}`);
}

function getTokens() {
  const props = PropertiesService.getScriptProperties();
  const t = {
    airtable: props.getProperty('AIRTABLE_TOKEN'),
    igToken:  props.getProperty('IG_ACCESS_TOKEN'),
    igUserId: props.getProperty('IG_USER_ID')
  };
  if (!t.airtable) throw new Error('Falta AIRTABLE_TOKEN');
  if (!t.igToken)  throw new Error('Falta IG_ACCESS_TOKEN');
  if (!t.igUserId) throw new Error('Falta IG_USER_ID');
  return t;
}

// ── AIRTABLE ────────────────────────────────────────────────────────────────
function findAprobados(token) {
  const formula = encodeURIComponent("{Estado} = 'Aprobado'");
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_POSTS}?filterByFormula=${formula}&maxRecords=10`;
  const resp = UrlFetchApp.fetch(url, { headers: { 'Authorization': 'Bearer ' + token }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('list aprobados: ' + resp.getContentText());
  return JSON.parse(resp.getContentText()).records || [];
}

function getFotoById(fotoId, token) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_FOTOS}/${fotoId}`;
  const resp = UrlFetchApp.fetch(url, { headers: { 'Authorization': 'Bearer ' + token }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error(`get foto ${fotoId}: ${resp.getContentText()}`);
  return JSON.parse(resp.getContentText());
}

function patchAirtable(table, recordId, fields, token) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}/${recordId}`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'patch', headers: { 'Authorization': 'Bearer ' + token },
    contentType: 'application/json', payload: JSON.stringify({ fields }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) throw new Error(`PATCH ${table}/${recordId}: ${resp.getContentText()}`);
  return JSON.parse(resp.getContentText());
}

function createAirtableRecord(table, fields, token) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'post', headers: { 'Authorization': 'Bearer ' + token },
    contentType: 'application/json', payload: JSON.stringify({ fields, typecast: true }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) throw new Error(`POST ${table}: ${resp.getContentText()}`);
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
    DriveApp.getFileById(fileId).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    Logger.log(`⚠ sharing ${fileId}: ${e.message}`);
  }
}

function imageUrlForIG(driveUrl) {
  const id = extractDriveFileId(driveUrl);
  if (!id) throw new Error('Sin file ID: ' + driveUrl);
  ensureDrivePublic(id);
  return `https://lh3.googleusercontent.com/d/${id}=s2048`;
}

function videoUrlForIG(driveUrl) {
  const id = extractDriveFileId(driveUrl);
  if (!id) throw new Error('Sin file ID: ' + driveUrl);
  ensureDrivePublic(id);
  return `https://drive.google.com/uc?export=download&id=${id}`;
}

// ── INSTAGRAM API ───────────────────────────────────────────────────────────
function igPost(path, params, igToken) {
  const formData = Object.assign({ access_token: igToken }, params);
  const resp = UrlFetchApp.fetch(`${IG_API_BASE}/${path}`, {
    method: 'post', payload: formData, muteHttpExceptions: true
  });
  const body = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() !== 200 || body.error) {
    throw new Error(`IG ${path}: ${JSON.stringify(body.error || body)}`);
  }
  return body;
}

function igGet(path, params, igToken) {
  const qs = Object.entries(Object.assign({ access_token: igToken }, params))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const resp = UrlFetchApp.fetch(`${IG_API_BASE}/${path}?${qs}`, { muteHttpExceptions: true });
  const body = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() !== 200 || body.error) {
    throw new Error(`IG GET ${path}: ${JSON.stringify(body.error || body)}`);
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
      is_carousel_item: 'true'
    }, igToken);
    waitForVideoReady(result.id, igToken);
    return result.id;
  } else {
    const result = igPost(`${igUserId}/media`, {
      image_url: imageUrlForIG(driveUrl),
      is_carousel_item: 'true'
    }, igToken);
    return result.id;
  }
}

function waitForVideoReady(mediaId, igToken) {
  for (let i = 0; i < VIDEO_POLL_MAX_ATTEMPTS; i++) {
    Utilities.sleep(VIDEO_POLL_INTERVAL_MS);
    const status = igGet(mediaId, { fields: 'status_code' }, igToken);
    Logger.log(`Video ${mediaId}: ${status.status_code}`);
    if (status.status_code === 'FINISHED') return;
    if (['ERROR', 'EXPIRED'].includes(status.status_code)) {
      throw new Error(`Video ${mediaId}: ${status.status_code}`);
    }
  }
  throw new Error(`Timeout video ${mediaId}`);
}

function createCarouselAndPublish(igUserId, mediaIds, caption, igToken) {
  const container = igPost(`${igUserId}/media`, {
    media_type: 'CAROUSEL',
    children: mediaIds.join(','),
    caption: caption
  }, igToken);
  const published = igPost(`${igUserId}/media_publish`, { creation_id: container.id }, igToken);
  return published.id;
}

// ── PIPELINE ────────────────────────────────────────────────────────────────
function processPost(post, tokens) {
  const fields = post.fields;
  const fotoIds = (fields['Fotos IDs'] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (fotoIds.length < 2) throw new Error(`Min 2 items, tiene ${fotoIds.length}`);
  if (fotoIds.length > 10) throw new Error(`Max 10 items, tiene ${fotoIds.length}`);

  const caption = (fields['Caption'] || '').replace(/\s\|\s/g, '\n\n');
  Logger.log(`Publicando ${post.id} con ${fotoIds.length} slides`);

  // 1. Crear media items
  const mediaIds = [];
  const fotoData = [];
  for (let i = 0; i < fotoIds.length; i++) {
    const foto = getFotoById(fotoIds[i], tokens.airtable);
    fotoData.push(foto);
    Logger.log(`  Slide ${i+1}: ${foto.fields.Nombre} (${foto.fields.Tipo || 'Foto'})`);
    mediaIds.push(createIGMediaItem(tokens.igUserId, foto, tokens.igToken));
  }

  // 2. Carrusel + publish
  const igPostId = createCarouselAndPublish(tokens.igUserId, mediaIds, caption, tokens.igToken);
  Logger.log(`✓ IG post ${igPostId}`);

  // 3. Update POSTS
  const today = Utilities.formatDate(new Date(), 'America/Santo_Domingo', 'yyyy-MM-dd');
  patchAirtable(TABLE_POSTS, post.id, {
    [F_ESTADO]: 'Publicado',
    [F_IG_POST_ID]: igPostId,
    [F_FECHA_PUB]: today
  }, tokens.airtable);

  // 4. Update fotos + USOS
  for (let i = 0; i < fotoData.length; i++) {
    const foto = fotoData[i];
    const slideNum = i + 1;
    const prevUsos = foto.fields['Total Usos'] || 0;
    const basePoints = POINTS_BY_SLIDE[slideNum] || POINTS_DEFAULT;
    const points = basePoints + (prevUsos * POINTS_BONUS_PER_REPEAT);

    patchAirtable(TABLE_FOTOS, foto.id, {
      'Total Usos': prevUsos + 1,
      'Última Vez Usada': today,
      'Último Slide': slideNum,
      'Último Post ID': igPostId
    }, tokens.airtable);

    createAirtableRecord(TABLE_USOS, {
      'Foto': [foto.id], 'Post': [post.id],
      'Número de Slide': slideNum, 'Fecha': today,
      'Puntos Asignados': points
    }, tokens.airtable);

    Logger.log(`  ${foto.fields.Nombre}: slide ${slideNum}, +${points} pts`);
  }
}

function markPostError(postId, errorMsg, airtableToken) {
  try {
    patchAirtable(TABLE_POSTS, postId, {
      [F_ESTADO]: 'Rechazado',
      [F_CAPTION]: '❌ ERROR: ' + errorMsg.substring(0, 500)
    }, airtableToken);
  } catch (e) {
    Logger.log(`No marca error en ${postId}: ${e.message}`);
  }
}

// ── SETUP ───────────────────────────────────────────────────────────────────
function installPublisherTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'publishApprovedPosts')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('publishApprovedPosts').timeBased().everyMinutes(5).create();
  Logger.log('Trigger instalado: publishApprovedPosts cada 5 min');
}

function testPublishRun() {
  publishApprovedPosts();
}

// ── TOKEN REFRESH (correr cada ~50 días) ────────────────────────────────────
function refreshIGToken() {
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperty('IG_ACCESS_TOKEN');
  // IG Login API tiene endpoint propio de refresh — no necesita app secret
  const url = `${IG_API_BASE}/refresh_access_token?grant_type=ig_refresh_token&access_token=${current}`;
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(resp.getContentText());
  if (data.access_token) {
    props.setProperty('IG_ACCESS_TOKEN', data.access_token);
    Logger.log(`Token refrescado. Expira en ${(data.expires_in / 86400).toFixed(0)} días`);
  } else {
    Logger.log('Refresh error: ' + JSON.stringify(data));
  }
}
