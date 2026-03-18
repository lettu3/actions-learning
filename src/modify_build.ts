import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import fsPromises from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.resolve(__dirname, '../deploy_config.json');
const zipPath = path.resolve(__dirname, '../temp/build.zip');
const distPath = path.resolve(__dirname, '../dist');

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

async function modifyHTML(indexPath: string, config: any): Promise<void> {
    try {
        let content = await fsPromises.readFile(indexPath, 'utf-8');
        
        if (config.html_modify?.title) {
            content = content.replace(/<title>.*<\/title>/, `<title>${config.html_modify.title}</title>`);
        }

        content = content.replace(/\n\s*\n/g, '\n');

        await fsPromises.writeFile(indexPath, content, 'utf-8');
        console.log(`✅ HTML Modificado: Título actualizado y código linteado.`);
    } catch (error) {
        console.error(`❌ Error al modificar ${indexPath}:`, error);
        throw error;
    }
}

async function injectSceneDataToHTML(distPath: string, indexPath: string): Promise<void> {
    const indexMjsPath = path.join(distPath, 'js', 'index.mjs');  

    if (!fs.existsSync(indexMjsPath)) {
        console.log(`⚠️ No se encontró index.mjs para extraer SCENE_PATH.`);
        return;
    }

    try {
        const settingsContent = await fsPromises.readFile(indexMjsPath, 'utf-8');
        const scenePathMatch = settingsContent.match(/const SCENE_PATH\s*=\s*"([^"]+)";/);
        
        if (!scenePathMatch || !scenePathMatch[1]) return;

        const sceneFilename = scenePathMatch[1];
        const sceneJsonPath = path.join(distPath, sceneFilename);

        if (!fs.existsSync(sceneJsonPath)) return;

        const sceneJsonContent = await fsPromises.readFile(sceneJsonPath, 'utf-8');
        const sceneData = JSON.parse(sceneJsonContent);

        const branchId = sceneData.branch_id;
        const checkpointId = sceneData.checkpoint_id;
        const sceneId = sceneData.id;

        if (!branchId || !checkpointId) return;

        let htmlContent = await fsPromises.readFile(indexPath, 'utf-8');
        
        // Formateado con la indentación exacta y un solo salto al final
        const metaTags = `    <meta name="pc-branch-id" content="${branchId}">
    <meta name="pc-checkpoint-id" content="${checkpointId}">
    <meta name="pc-scene-id" content="${sceneId}">
    <!-- Deployed on: ${new Date().toISOString()} -->
    \n`;

        if (htmlContent.includes('</head>')) {
            htmlContent = htmlContent.replace('</head>', `${metaTags}</head>`);
        }

        await fsPromises.writeFile(indexPath, htmlContent, 'utf-8');
        console.log(`✅ HTML Modificado: Metadatos de escena inyectados.`);

    } catch (error) {
        console.error(`❌ Error al inyectar datos de la escena:`, error);
    }
}


async function modifyJS(distPath: string, config: any): Promise<void> {
    const jsPath = path.join(distPath, 'js', 'index.mjs');
    if (!fs.existsSync(jsPath)) {
        console.log(`⚠️ No se encontró el archivo index.mjs. Omitiendo modificación de JS.`);
        return;
    }

    const cdnUrl = config.html_modify?.cdn_url;
    const projectPath = config.sftp?.remote_path;

    if (!cdnUrl || !projectPath) {
        console.log(`⚠️ Faltan 'cdn_url' o 'project_name' en el config. No se puede modificar JS.`);
        return;
    }

    // Limpiamos los segmentos para evitar dobles barras
    const cleanCdn = cdnUrl.replace(/\/+$/, '');
    // Quitamos 'html/' del remote_path para el CDN, y limpiamos barras
    const cleanPath = projectPath.replace(/^html\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
    const baseUrl = `${cleanCdn}/${cleanPath}`;

    try {
        let content = await fsPromises.readFile(jsPath, 'utf-8');

        // Reemplazamos usando expresiones regulares para encontrar y sustituir exactamente los valores
        // Agregamos una barra al final solo si no queda vacía la baseUrl
        const prefix = baseUrl ? `${baseUrl}/` : '';
        content = content.replace(/const ASSET_PREFIX\s*=\s*"[^"]*";/, `const ASSET_PREFIX = "${prefix}";`);
        content = content.replace(/const SCRIPT_PREFIX\s*=\s*"[^"]*";/, `const SCRIPT_PREFIX = "${prefix}";`);
        content = content.replace(/const CONFIG_FILENAME\s*=\s*"[^"]*";/, `const CONFIG_FILENAME = "${prefix}config.json";`);

        await fsPromises.writeFile(jsPath, content, 'utf-8');
        console.log(`✅ JS Modificado: Se actualizaron ASSET, SCRIPT y CONFIG en index.mjs`);
    } catch (error) {
        console.error(`❌ Error al modificar ${jsPath}:`, error);
        throw error;
    }
}

/**
 * Since PlayCanvas is PURE BULLSHIT, and it exports config.json with /api/ URLs, 
 * we need to fix it ourselves.
 */
async function modifyConfigJSON(distPath: string): Promise<void> {
    const configJsonPath = path.join(distPath, 'config.json');
    if (!fs.existsSync(configJsonPath)) return;

    try {
        const configData = JSON.parse(await fsPromises.readFile(configJsonPath, 'utf-8'));

        let modified = false;
        if (configData.assets) {
            for (const key in configData.assets) {
                const asset = configData.assets[key];
                // Si la URL arranca con /api/, la pisamos por la ruta real de los assets
                if (asset.file && asset.file.url && asset.file.url.startsWith('/api/')) {
                    asset.file.url = `files/assets/${key}/1/${asset.file.filename}`;
                    modified = true;
                }
            }
        }

        if (modified) {
            // Guardamos el JSON pisado sin espacios extra para ahorrar peso
            await fsPromises.writeFile(configJsonPath, JSON.stringify(configData), 'utf-8');
            console.log(`✅ config.json Modificado: Se corrigieron las rutas huérfanas '/api/'.`);
        }
    } catch (error) {
        console.error(`❌ Error al modificar config.json:`, error);
    }
}


export async function modifyBuild() {
    try {
        console.log('🏗️ Iniciando proceso de modificación del build...');

        if (!fs.existsSync(zipPath)) {
            throw new Error("No se encontró build.zip. Asegúrate de correr fetch_playcanvas.ts primero.");
        }

        if (fs.existsSync(distPath)) {
            console.log(`🗑️ Limpiando carpeta dist anterior...`);
            fs.rmSync(distPath, { recursive: true, force: true });
        }

        console.log(`📦🔜📂 Extrayendo archivos...`);
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(distPath, true);
        console.log(`✅ Archivos extraídos en: ${distPath}`);

        const indexPath = path.join(distPath, 'index.html');
        if (!fs.existsSync(indexPath)) {
            throw new Error("No se encontró index.html dentro del archivo extraído.");
        }

        const tasks: Promise<void>[] = [];

        const mods = config.html_modify;
        if (mods && mods.modify_indexhtml) {
            tasks.push((async () => {
                await injectSceneDataToHTML(distPath, indexPath); // 1ro: Inyecta las <meta> tags
                await modifyHTML(indexPath, config);              // 2do: Inyecta el comentario "Deployed on:" abajo del todo
            })());
        } else {
            console.log(`⏩ Modificaciones HTML deshabilitadas en el config. Borrando index.html del build.`);
            if (fs.existsSync(indexPath)) {
                fs.unlinkSync(indexPath);
            }
        }

        tasks.push(modifyJS(distPath, config));
        tasks.push(modifyConfigJSON(distPath));

        if (tasks.length > 0) {
            console.log('💫 Aplicando modificaciones en paralelo...');
            await Promise.all(tasks);
            console.log('✅ Modificaciones completadas.');
        }

        // Limpieza final: borrar el .zip si todo salió bien
        if (fs.existsSync(zipPath)) {
            console.log(`🧹 Limpiando archivo temporal: ${path.basename(zipPath)}`);
            fs.unlinkSync(zipPath);
        }
        
    } catch (error) {
        console.error("❌ Error: proceso interrumpido", error);
        process.exit(1);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    modifyBuild();
}
