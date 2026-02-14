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

// En build queda: dist/<app>/server  y  dist/<app>/browser
const browserDistFolder = join(__dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

/**
 * 1) Static files (js/css/images/etc.)
 *    Si no existe el archivo, hace next() (fallthrough) y NO responde HTML aquí.
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
    fallthrough: true,
  }),
);

/**
 * 2) Si pidieron un archivo con extensión y no se encontró como estático,
 *    NO lo mandes a SSR: responde 404 (evita MIME text/html en .js).
 */
app.use((req, res, next) => {
  if (req.path.includes('.')) {
    res.status(404).type('text/plain').send('Not Found');
    return;
  }

  // Para HTML SSR evita cache (reduce chunks viejos)
  res.setHeader('Cache-Control', 'no-store');
  return next();
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
    console.log(`Static folder: ${browserDistFolder}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
