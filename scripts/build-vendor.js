'use strict';

/**
 * Genera public/js/vendor/vercel-blob-client.js a partir de @vercel/blob/client
 * para poder subir archivos directo del navegador a Vercel Blob (sin pasar por el
 * servidor, que en Vercel tiene un límite de 4.5 MB por petición).
 *   npm run build:vendor
 */
const path = require('node:path');
const esbuild = require('esbuild');

esbuild
  .build({
    stdin: {
      contents: "export { upload } from '@vercel/blob/client';",
      resolveDir: path.join(__dirname, '..'),
    },
    bundle: true,
    format: 'iife',
    globalName: 'VercelBlob',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    outfile: path.join(__dirname, '..', 'public', 'js', 'vendor', 'vercel-blob-client.js'),
    logLevel: 'info',
  })
  .catch(() => process.exit(1));
