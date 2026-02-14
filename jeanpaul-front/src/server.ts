import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// En producción (build), server queda en: dist/<app>/server
// y browser queda en: dist/<app>/browser
const browserDistFolder = join(__dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

/**
 * 1) Estáticos SOLO para rutas con extensión (js, css, png, etc.)
 *    Así evitamos que /chunk-XYZ.js termine respondiendo HTML.
 */
app.get(
  '*.*',
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
    // (opcional) si quieres:
    // immutable: true,
  }),
);

/**
 * 2) Para rutas HTML (sin extensión), evita cache del documento:
 *    esto reduce el riesgo de que el navegador conserve HTML viejo que
 *    apunta a chunks que ya no existen.
 */
app.use((req, res, next) => {
  if (!req.path.includes('.')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

/**
 * 3) SSR para el resto
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = Number(process.env['PORT'] || 4000);

  app.listen(port, '0.0.0.0', (error?: unknown) => {
    if (error) throw error;
    console.log(`SSR listening on 0.0.0.0:${port}`);
    console.log(`Serving static from: ${browserDistFolder}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
