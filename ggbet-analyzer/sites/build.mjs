import {build} from 'esbuild';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
await mkdir('dist/server',{recursive:true});
await mkdir('dist/.openai',{recursive:true});
const browser = await build({entryPoints:['sites/client.tsx'],bundle:true,write:false,minify:true,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
await writeFile('sites/generated-client.txt',browser.outputFiles[0].text);
await build({entryPoints:['sites/worker.ts'],bundle:true,minify:true,format:'esm',platform:'browser',target:'es2022',outfile:'dist/server/index.js',external:['node:*'],alias:{'next/server':path.resolve('sites/next-server.ts')},loader:{'.txt':'text','.webmanifest':'text','.svg':'text'},define:{'process.env':'{}'}});
await copyFile('.openai/hosting.json','dist/.openai/hosting.json');
