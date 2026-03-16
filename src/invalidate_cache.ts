import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import type { DeployConfig } from 'deploy_config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.resolve(__dirname, '../deploy_config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as DeployConfig;

// Validar credenciales de AWS
const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION } = process.env;

if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    console.error("❌ Error: Faltan las credenciales de AWS en el archivo .env");
    process.exit(1);
}

export async function invalidateCache() {
    try {
        console.log('🚀 Iniciando invalidación de caché en CloudFront...');

        const distributionId = config.html_modify?.cloudfront_distribution_id;
        const remotePath = config.sftp?.remote_path;

        if (!distributionId) {
            throw new Error("No se encontró 'cloudfront_distribution_id' en la configuración de html_modify.");
        }

        if (!remotePath) {
            throw new Error("No se encontró 'remote_path' en la configuración de sftp.");
        }

        // Limpiar y formatear el path: 
        // 1. Quitamos "html/" del inicio.
        // 2. Quitamos "/" extras al inicio o final para evitar errores.
        const cleanPath = remotePath.replace(/^html\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
        
        // 3. Armamos el path final de invalidación asegurando la barra inicial y el comodín al final.
        // Ejemplo: "html/ladeseada/" -> "/ladeseada/*"
        const invalidationPath = `/${cleanPath}/*`;

        console.log(`🔎 Path calculado a invalidar: ${invalidationPath}`);

        // Inicializar el cliente de AWS
        const client = new CloudFrontClient({
            region: AWS_REGION as string || 'us-east-1' ,
            credentials: {
                accessKeyId: AWS_ACCESS_KEY_ID as string,
                secretAccessKey: AWS_SECRET_ACCESS_KEY as string,
            }
        });

        // AWS requiere un CallerReference único para evitar invalidaciones duplicadas accidentales
        const callerReference = `invalidate-${Date.now()}`;

        const command = new CreateInvalidationCommand({
            DistributionId: distributionId,
            InvalidationBatch: {
                CallerReference: callerReference,
                Paths: {
                    Quantity: 1,
                    Items: [invalidationPath]
                }
            }
        });

        console.log(`📤 Enviando solicitud a AWS (Distribution ID: ${distributionId})...`);
        const response = await client.send(command);

        const invalidationId = response.Invalidation?.Id;
        console.log(`✅ ¡Invalidación creada con éxito! ID: ${invalidationId}`);
        console.log(`⏳ Los servidores de borde de CloudFront se están actualizando.`);

    } catch (error) {
        console.error("❌ Error: proceso de invalidación interrumpido", error);
        process.exit(1);
    }
}

invalidateCache();