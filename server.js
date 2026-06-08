const express = require('express');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_KEY = process.env.GEMINI_KEY;
const SHEETS_ID = process.env.SHEETS_ID;
const GOOGLE_CRED = JSON.parse(process.env.GOOGLE_CRED || '{}');

// ── Google Sheets Auth ────────────────────────────────────────────
function base64url(buf) {
  return buf.toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

async function getSheetsToken() {
  const now = Math.floor(Date.now()/1000);
  const header = base64url(Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})));
  const claim = base64url(Buffer.from(JSON.stringify({
    iss: GOOGLE_CRED.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now+3600, iat: now
  })));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + claim);
  const sig = base64url(sign.sign(GOOGLE_CRED.private_key));
  const jwt = header + '.' + claim + '.' + sig;
  return new Promise((resolve, reject) => {
    const body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt;
    const req = https.request({
      hostname:'oauth2.googleapis.com', path:'/token', method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d).access_token);}catch(e){reject(e);} }); });
    req.on('error',reject); req.write(body); req.end();
  });
}

async function sheetsReq(method, spath, body, token) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname:'sheets.googleapis.com', path:spath, method,
      headers:{'Authorization':'Bearer ' + token,'Content-Type':'application/json',...(bodyStr?{'Content-Length':Buffer.byteLength(bodyStr)}:{})}
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){resolve({});} }); });
    req.on('error',reject);
    if(bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function sheetRead(tab) {
  const token = await getSheetsToken();
  const enc = encodeURIComponent(tab);
  const r = await sheetsReq('GET', '/v4/spreadsheets/' + SHEETS_ID + '/values/' + enc, null, token);
  const rows = r.values || [];
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h,i) => { obj[h] = row[i] || ''; });
    return obj;
  });
}

async function sheetWrite(tab, rows) {
  const token = await getSheetsToken();
  const enc = encodeURIComponent(tab);
  const r = await sheetsReq('GET', '/v4/spreadsheets/' + SHEETS_ID + '/values/' + enc + '!1:1', null, token);
  const headers = (r.values && r.values[0]) || [];
  if (!headers.length) return;
  const values = [headers, ...rows.map(row => headers.map(h => {
    const v = row[h];
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }))];
  await sheetsReq('PUT', '/v4/spreadsheets/' + SHEETS_ID + '/values/' + enc + '?valueInputOption=RAW', { values }, token);
}

// ── Gemini call ───────────────────────────────────────────────────
function geminiRequest(parts) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents:[{parts}],
      generationConfig:{temperature:0.1}
    });
    const req = https.request({
      hostname:'generativelanguage.googleapis.com',
      path:'/v1beta/models/gemini-1.5-flash:generateContent?key=' + GEMINI_KEY,
      method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
    }, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        try {
          const r = JSON.parse(d);
          const txt = r.candidates && r.candidates[0] && r.candidates[0].content && r.candidates[0].content.parts && r.candidates[0].content.parts[0] ? r.candidates[0].content.parts[0].text : '{}';
          resolve(txt.replace(/```json/g,'').replace(/```/g,'').trim());
        } catch(e){reject(e);}
      });
    });
    req.on('error',reject); req.write(body); req.end();
  });
}

// ── Build prompts ─────────────────────────────────────────────────
function buildTextPrompt(text) {
  const now = new Date();
  const dia = now.getDate();
  const mes = now.getMonth() + 1;
  const ano = now.getFullYear();
  const mesStr = mes < 10 ? '0' + mes : String(mes);
  const diaStr = dia < 10 ? '0' + dia : String(dia);

  return 'Voce e assistente de uma agencia de marketing. Analise o texto e retorne APENAS JSON valido, sem markdown, sem explicacoes, sem aspas extras.\n\n' +
    'Texto: "' + text + '"\n\n' +
    'Retorne exatamente este JSON (substitua os valores):\n' +
    '{"texto":"descricao clara da tarefa","urgente":false,"importante":false,"tag":null,"temFinanceiro":false,"cliente":"Cliente Avulso","valor":0,"vencimento":null,"tipo":"pontual","checklist":[]}\n\n' +
    'Regras:\n' +
    '- temFinanceiro: true se mencionar qualquer valor monetario, R$, reais, pagamento, vencimento ou nome de cliente\n' +
    '- cliente: nome do cliente mencionado. Se nao houver, use "Cliente Avulso"\n' +
    '- valor: apenas o numero. R$1000=1000, 90 reais=90\n' +
    '- vencimento: formato DD/MM/AAAA. "dia 15" = 15/' + mesStr + '/' + ano + '\n' +
    '- tipo: mensal se mencionar mensal ou recorrente, senao pontual\n' +
    '- texto: descricao clara do que precisa ser feito\n' +
    '- checklist: liste cada servico separado se houver multiplos, senao deixe vazio';
}

function buildAudioPrompt(text) {
  const now = new Date();
  const mes = now.getMonth() + 1;
  const ano = now.getFullYear();
  const mesStr = mes < 10 ? '0' + mes : String(mes);

  return 'Transcreva o audio e interprete como tarefa de agencia de marketing. Retorne APENAS JSON valido sem markdown.\n\n' +
    '{"transcricao":"texto exato do audio","texto":"descricao clara da tarefa","urgente":false,"importante":false,"tag":null,"temFinanceiro":false,"cliente":"Cliente Avulso","valor":0,"vencimento":null,"tipo":"pontual","checklist":[]}\n\n' +
    'Regras:\n' +
    '- transcricao: exatamente o que foi dito\n' +
    '- texto: descricao clara da tarefa (NUNCA use "Tarefa de audio")\n' +
    '- temFinanceiro: true se mencionar valor, R$, pagamento, cliente\n' +
    '- cliente: nome do cliente ou "Cliente Avulso"\n' +
    '- valor: apenas o numero\n' +
    '- vencimento: DD/MM/AAAA ou null. "dia 15" = 15/' + mesStr + '/' + ano + '\n' +
    '- tipo: mensal se recorrente, senao pontual';
}

// ── Routes ────────────────────────────────────────────────────────
app.get('/api/health', (req,res) => res.json({ok:true}));

app.get('/api/tarefas', async (req,res) => {
  try { res.json(await sheetRead('Tarefas')); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/financeiro', async (req,res) => {
  try { res.json(await sheetRead('Financeiro')); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/servicos', async (req,res) => {
  try { res.json(await sheetRead('Servicos')); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/tarefas', async (req,res) => {
  try { await sheetWrite('Tarefas', req.body); res.json({ok:true}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/financeiro', async (req,res) => {
  try { await sheetWrite('Financeiro', req.body); res.json({ok:true}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/parse-text', async (req,res) => {
  try {
    const text = req.body.text;
    const prompt = buildTextPrompt(text);
    const raw = await geminiRequest([{text: prompt}]);
    const parsed = JSON.parse(raw);
    const id = Date.now().toString();
    const now = new Date().toLocaleDateString('pt-BR');

    const task = {
      id,
      texto: parsed.texto || text,
      feito: 'false',
      urgente: parsed.urgente ? 'true' : 'false',
      importante: parsed.importante ? 'true' : 'false',
      tag: parsed.tag || '',
      criadoEm: now,
      concluidoEm: '',
      subtarefas: JSON.stringify(parsed.checklist || [])
    };

    const tasks = await sheetRead('Tarefas');
    tasks.push(task);
    await sheetWrite('Tarefas', tasks);

    let finEntry = null;
    if (parsed.temFinanceiro) {
      finEntry = {
        id: id + '_fin',
        cliente: parsed.cliente || 'Cliente Avulso',
        descricao: parsed.texto || text,
        valor: parsed.valor || 0,
        vencimento: parsed.vencimento || '',
        status: 'pendente',
        tipo: parsed.tipo || 'pontual',
        servicoId: ''
      };
      const fin = await sheetRead('Financeiro');
      fin.push(finEntry);
      await sheetWrite('Financeiro', fin);
    }

    res.json({ ok:true, task, finEntry, parsed });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/parse-audio', upload.single('audio'), async (req,res) => {
  try {
    const audioBase64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'audio/webm';
    const promptText = buildAudioPrompt();
    const raw = await geminiRequest([
      {inline_data:{mime_type:mimeType, data:audioBase64}},
      {text: promptText}
    ]);
    const parsed = JSON.parse(raw);
    const id = Date.now().toString();
    const now = new Date().toLocaleDateString('pt-BR');

    const task = {
      id,
      texto: parsed.texto || parsed.transcricao || 'Nova tarefa',
      feito: 'false',
      urgente: parsed.urgente ? 'true' : 'false',
      importante: parsed.importante ? 'true' : 'false',
      tag: parsed.tag || '',
      criadoEm: now,
      concluidoEm: '',
      subtarefas: JSON.stringify(parsed.checklist || [])
    };

    const tasks = await sheetRead('Tarefas');
    tasks.push(task);
    await sheetWrite('Tarefas', tasks);

    let finEntry = null;
    if (parsed.temFinanceiro) {
      finEntry = {
        id: id + '_fin',
        cliente: parsed.cliente || 'Cliente Avulso',
        descricao: task.texto,
        valor: parsed.valor || 0,
        vencimento: parsed.vencimento || '',
        status: 'pendente',
        tipo: parsed.tipo || 'pontual',
        servicoId: ''
      };
      const fin = await sheetRead('Financeiro');
      fin.push(finEntry);
      await sheetWrite('Financeiro', fin);
    }

    res.json({ ok:true, task, finEntry, transcricao: parsed.transcricao });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.patch('/api/tarefas/:id', async (req,res) => {
  try {
    const tasks = await sheetRead('Tarefas');
    const idx = tasks.findIndex(t => t.id === req.params.id);
    if(idx === -1) return res.status(404).json({error:'not found'});
    Object.assign(tasks[idx], req.body);
    await sheetWrite('Tarefas', tasks);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.patch('/api/financeiro/:id', async (req,res) => {
  try {
    const fin = await sheetRead('Financeiro');
    const idx = fin.findIndex(f => f.id === req.params.id);
    if(idx === -1) return res.status(404).json({error:'not found'});
    Object.assign(fin[idx], req.body);
    await sheetWrite('Financeiro', fin);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/api/tarefas/:id', async (req,res) => {
  try {
    let tasks = await sheetRead('Tarefas');
    tasks = tasks.filter(t => t.id !== req.params.id);
    await sheetWrite('Tarefas', tasks);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Plius server running on port ' + PORT));
