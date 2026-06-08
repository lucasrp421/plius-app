# Plius App — Servidor Web + App Mobile

## Deploy no Railway

### 1. Suba para o GitHub
```
git init
git add .
git commit -m "first commit"
git remote add origin https://github.com/SEU_USUARIO/plius-app.git
git push -u origin main
```

### 2. Deploy no Railway
- Acesse railway.app e faça login com GitHub
- Clique em "New Project" → "Deploy from GitHub repo"
- Selecione o repositório `plius-app`
- Vá em "Variables" e adicione:

```
GEMINI_KEY=sua_chave_gemini
SHEETS_ID=1ZiofzRg5lNgHtyVgGRlYZ7AhNizZ45G1oYwlxE2DTJQ
GOOGLE_CRED={"type":"service_account","project_id":"plius-widget",...}  ← cole o JSON inteiro
PORT=3000
```

### 3. Acesse
- Railway vai gerar uma URL tipo: `https://plius-app-production.up.railway.app`
- Essa URL é seu app mobile — abra no celular
- Adicione à tela inicial do iPhone/Android para usar como app

## Atualização do Widget PC

No widget (index.html), configure a URL do servidor Railway nas configurações.
