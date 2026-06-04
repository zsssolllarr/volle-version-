const Busboy = require('busboy');

const FORM_ID = process.env.JOTFORM_FORM_ID || '261543045360046';
const API_KEY = process.env.JOTFORM_API_KEY;

function parseMultipart(event){
  return new Promise((resolve, reject) => {
    const headers = {};
    for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;

    const bb = Busboy({ headers, limits: { fileSize: 20 * 1024 * 1024, files: 30 } });
    const fields = {};
    const files = {};

    bb.on('field', (name, value) => { fields[name] = value; });

    bb.on('file', (name, file, info) => {
      const chunks = [];
      const filename = info && info.filename ? info.filename : '';
      const mimeType = info && info.mimeType ? info.mimeType : 'application/octet-stream';
      file.on('data', chunk => chunks.push(chunk));
      file.on('end', () => {
        if (!filename) return;
        if (!files[name]) files[name] = [];
        files[name].push({ filename, mimeType, buffer: Buffer.concat(chunks) });
      });
    });

    bb.on('error', reject);
    bb.on('finish', () => resolve({ fields, files }));

    const bodyBuffer = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');
    bb.end(bodyBuffer);
  });
}

async function getQuestions(){
  if (!API_KEY) throw new Error('JOTFORM_API_KEY fehlt in Netlify');
  const res = await fetch(`https://api.jotform.com/form/${FORM_ID}/questions?apiKey=${encodeURIComponent(API_KEY)}`);
  const json = await res.json();
  if (!res.ok || json.responseCode !== 200) throw new Error('Jotform Fragen konnten nicht geladen werden');
  return json.content || {};
}

function clean(s){
  return String(s || '').toLowerCase().replace(/&amp;/g,'&').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}

function findQuestion(questions, titles){
  const wanted = titles.map(clean);
  for (const q of Object.values(questions)) {
    const t = clean(q.text || q.name || '');
    if (wanted.some(w => t === w || t.includes(w) || w.includes(t))) return q;
  }
  return null;
}

function firstTextarea(questions){
  return Object.values(questions).find(q => String(q.type || '').toLowerCase().includes('textarea')) || null;
}

function fileText(files, name){
  return files[name] && files[name].length ? files[name].map(f => f.filename).join(', ') : '—';
}

function buildFullSummary(fields, files){
  const project = fields.interne_projektnummer || fields.projektnummer || 'ohne Projektnummer';
  const pdfName = fields.interner_dateiname || `Feinplanung_${project}.pdf`;
  return `${fields.zusammenfassung || ''}

### Interne Ablage / Dateibenennung
Projekt-/Feinplanungsnummer: ${project}
Empfohlener PDF-Dateiname: ${pdfName}

${fields.montage_ordner_struktur || ''}

### Uploads / Dateinamen
Dachbilder: ${fileText(files,'dachbilder')}
Modulbelegung: ${fileText(files,'modulbelegung')}
Fassade: ${fileText(files,'fassade_einzeichnung')}
Leitungsweg innen: ${fileText(files,'leitungsweg_innen')}
Umgebung Gesamt: ${fileText(files,'bild_umgebung_gesamt')}
Speicher nah: ${fileText(files,'bild_speicher_nah')}
WR nah: ${fileText(files,'bild_wr_nah')}
Zählerkasten: ${fileText(files,'bild_zaehler_detail')}
HAK: ${fileText(files,'bild_hak_detail')}
Erdung: ${fileText(files,'bild_erdung_detail')}
Kabelweg ZK → WR: ${fileText(files,'bild_kabelweg_zk_wr')}
Transportweg: ${fileText(files,'bild_transportweg')}
Sonstige: ${fileText(files,'bild_sonstige')}`.trim();
}

function appendText(formData, questions, fields, htmlName, titles){
  const q = findQuestion(questions, titles);
  const value = fields[htmlName];
  if (q && q.name && value && String(value).trim()) formData.append(q.name, value);
}

function appendFiles(formData, questions, files, htmlName, titles){
  const q = findQuestion(questions, titles);
  const uploaded = files[htmlName];
  if (!q || !q.name || !uploaded || !uploaded.length) return;

  for (const f of uploaded) {
    const blob = new Blob([f.buffer], { type: f.mimeType });
    formData.append(`${q.name}[]`, blob, f.filename);
  }
}

exports.handler = async (event) => {
  try{
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ success:false, message:'Falsche Methode' }) };
    }

    const { fields, files } = await parseMultipart(event);
    const questions = await getQuestions();

    const formData = new FormData();
    formData.append('formID', FORM_ID);
    formData.append('simple_spc', `${FORM_ID}-${FORM_ID}`);
    formData.append('event_id', `${Date.now()}_${Math.random().toString(36).slice(2)}`);
    formData.append('validatedNewRequiredFieldIDs', '');

    if (!fields.projektnummer && fields.interne_projektnummer) fields.projektnummer = fields.interne_projektnummer;

    appendText(formData, questions, fields, 'projektnummer', ['Projekt-/Angebotsnummer', 'Projekt Angebotsnummer']);
    appendText(formData, questions, fields, 'adresse', ['Objektadresse']);
    appendText(formData, questions, fields, 'telefon', ['Telefon']);
    appendText(formData, questions, fields, 'kunden_email', ['Kunden-E-Mail', 'Kunden Email']);
    appendText(formData, questions, fields, 'erfasst_von', ['Erfasst von']);
    appendText(formData, questions, fields, 'datum', ['Datum Feinplanung']);

    const nameQ = findQuestion(questions, ['Kundenname']);
    if (nameQ && nameQ.name && fields.kundenname) formData.append(`${nameQ.name}[first]`, fields.kundenname);

    const summaryQ =
      findQuestion(questions, ['Feinplanung Zusammenfassung', 'Zusammenfassung']) ||
      findQuestion(questions, ['Kunden-/Zugangshinweise', 'Kunden Zugangshinweise']) ||
      findQuestion(questions, ['Produkt-Hinweise', 'Produkt Hinweise']) ||
      findQuestion(questions, ['Elektro-Hinweise', 'Elektro Hinweise']) ||
      firstTextarea(questions);

    if (!summaryQ || !summaryQ.name) throw new Error('Kein Langtextfeld für die Zusammenfassung gefunden');
    formData.append(summaryQ.name, buildFullSummary(fields, files));

    appendFiles(formData, questions, files, 'dachbilder', ['Dachbilder hochladen', 'Dachbilder']);
    appendFiles(formData, questions, files, 'modulbelegung', ['Datei-Upload für Modulbelegung/Plan', 'Modulbelegung Plan']);
    appendFiles(formData, questions, files, 'fassade_einzeichnung', ['Fassade mit Einzeichnung']);
    appendFiles(formData, questions, files, 'leitungsweg_innen', ['Durchbrüche / Leitungsweg innen', 'Durchbrüche Leitungsweg innen']);
    appendFiles(formData, questions, files, 'bild_umgebung_gesamt', ['Speicher-/WR-Umgebung Gesamtansicht', 'Speicher WR Umgebung Gesamtansicht']);
    appendFiles(formData, questions, files, 'bild_speicher_nah', ['Geplanter Speicherstandort nah']);
    appendFiles(formData, questions, files, 'bild_wr_nah', ['Geplanter Wechselrichterstandort nah']);
    appendFiles(formData, questions, files, 'bild_zaehler_detail', ['Zählerkasten innen und geschlossen']);
    appendFiles(formData, questions, files, 'bild_hak_detail', ['Hausanschlusskasten / HAK', 'Hausanschlusskasten HAK']);
    appendFiles(formData, questions, files, 'bild_erdung_detail', ['Erdungsschiene / Potentialausgleich', 'Erdungsschiene Potentialausgleich']);
    appendFiles(formData, questions, files, 'bild_kabelweg_zk_wr', ['Kabelweg Zählerkasten zu Speicher / WR', 'Kabelweg Zählerkasten zu Speicher WR']);
    appendFiles(formData, questions, files, 'bild_transportweg', ['Transportweg zum Technikraum']);
    appendFiles(formData, questions, files, 'bild_sonstige', ['Sonstige Bilder']);

    const submitRes = await fetch(`https://submit.jotform.com/submit/${FORM_ID}/`, {
      method: 'POST',
      body: formData,
      headers: { 'User-Agent': 'Mozilla/5.0 Zukunftssolar-Netlify-Profi-Submit' }
    });

    const responseText = await submitRes.text();
    if (!submitRes.ok) {
      return { statusCode: 500, body: JSON.stringify({ success:false, message:`Jotform Submit Fehler ${submitRes.status}: ${responseText.slice(0, 250)}` }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success:true, message:'Feinplanung inklusive Bilder wurde an Jotform gesendet' }) };
  }catch(err){
    return { statusCode: 500, body: JSON.stringify({ success:false, message: err.message || 'Unbekannter Serverfehler' }) };
  }
};
