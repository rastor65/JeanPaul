import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const app = express();
const angularApp = new AngularNodeAppEngine();

// __dirname real para ESM
const __dirname = dirname(fileURLToPath(import.meta.url));

// En runtime (Railway) esto suele quedar: dist/<app>/server
// Entonces ../browser => dist/<app>/browser
let browserDistFolder = join(__dirname, '../browser');

// Fallback por si tu estructura difiere
if (!existsSync(browserDistFolder)) {
  // Ajusta "jeanpaul-front" al nombre real que aparece en tu start command: dist/<NOMBRE>/server/server.mjs
  browserDistFolder = join(process.cwd(), 'dist/jeanpaul-front/browser');
}

/**
 * 1) Sirve estáticos PRIMERO (chunks, assets, etc.)
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * 2) Si pidieron un archivo (tiene extensión) y no existió en static => 404 (evita que SSR devuelva HTML)
 *    IMPORTANTE: esto va DESPUÉS de express.static()
 */
app.use((req, res, next) => {
  if (/\.[a-z0-9]+$/i.test(req.path)) {
    res.status(404).type('text/plain').send('Not Found');
    return;
  }
  return next();
});

/**
 * 3) Evita cache del HTML SSR (para que no se quede un index viejo apuntando a chunks viejos)
 */
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  return next();
});

/**
 * 4) SSR handler
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
