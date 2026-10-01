import SwaggerParser from '@apidevtools/swagger-parser';

const specification = await SwaggerParser.validate('contracts/openapi.yaml');
console.log(`OpenAPI valid: ${specification.info.title} ${specification.info.version}`);
