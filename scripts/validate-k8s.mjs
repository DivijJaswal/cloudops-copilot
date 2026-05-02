import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const manifestDir = path.join(repoRoot, "infra", "k8s");
const expectedNamespace = "cloudops-copilot";
const supportedKinds = new Set([
  "Deployment",
  "Namespace",
  "PersistentVolumeClaim",
  "Service",
]);

const errors = [];
const resources = [];

if (!existsSync(manifestDir)) {
  fail(`Kubernetes manifest directory does not exist: ${manifestDir}`);
}

for (const fileName of readdirSync(manifestDir).filter((name) => name.endsWith(".yaml")).sort()) {
  const filePath = path.join(manifestDir, fileName);
  const content = readFileSync(filePath, "utf8");
  const documents = content
    .split(/^---\s*$/m)
    .map((document) => document.trim())
    .filter(Boolean);

  documents.forEach((document, index) => {
    try {
      const resource = parseYaml(document);
      resources.push({ fileName, documentIndex: index + 1, resource });
      validateResource(resource, fileName, index + 1);
    } catch (error) {
      errors.push(`${fileName} document ${index + 1}: ${error.message}`);
    }
  });
}

validateCrossResourceLinks(resources);

if (errors.length > 0) {
  console.error("Kubernetes manifest validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Validated ${resources.length} Kubernetes resources in ${path.relative(repoRoot, manifestDir)} without cluster access.`);
for (const { resource, fileName } of resources) {
  console.log(`- ${resource.kind}/${resource.metadata.name} (${fileName})`);
}

function validateResource(resource, fileName, documentIndex) {
  const location = `${fileName} document ${documentIndex}`;
  requireObject(resource, location);
  requireString(resource.apiVersion, `${location}: apiVersion`);
  requireString(resource.kind, `${location}: kind`);
  requireObject(resource.metadata, `${location}: metadata`);
  requireString(resource.metadata.name, `${location}: metadata.name`);

  if (!supportedKinds.has(resource.kind)) {
    errors.push(`${location}: unsupported kind ${resource.kind}`);
  }

  if (resource.kind === "Namespace") {
    if (resource.metadata.name !== expectedNamespace) {
      errors.push(`${location}: namespace must be named ${expectedNamespace}`);
    }
    return;
  }

  if (resource.metadata.namespace !== expectedNamespace) {
    errors.push(`${location}: metadata.namespace must be ${expectedNamespace}`);
  }

  if (resource.kind === "Deployment") {
    validateDeployment(resource, location);
  } else if (resource.kind === "Service") {
    validateService(resource, location);
  } else if (resource.kind === "PersistentVolumeClaim") {
    validatePersistentVolumeClaim(resource, location);
  }
}

function validateDeployment(resource, location) {
  requireObject(resource.spec, `${location}: spec`);
  requireObject(resource.spec.selector, `${location}: spec.selector`);
  requireNonEmptyObject(resource.spec.selector.matchLabels, `${location}: spec.selector.matchLabels`);
  requireObject(resource.spec.template, `${location}: spec.template`);
  requireObject(resource.spec.template.metadata, `${location}: spec.template.metadata`);
  requireNonEmptyObject(resource.spec.template.metadata.labels, `${location}: spec.template.metadata.labels`);
  requireObject(resource.spec.template.spec, `${location}: spec.template.spec`);
  requireArray(resource.spec.template.spec.containers, `${location}: spec.template.spec.containers`);

  for (const [key, value] of Object.entries(resource.spec.selector.matchLabels ?? {})) {
    if (resource.spec.template.metadata.labels?.[key] !== value) {
      errors.push(`${location}: selector label ${key}=${value} must match template labels`);
    }
  }

  for (const [index, container] of resource.spec.template.spec.containers.entries()) {
    const prefix = `${location}: container ${index + 1}`;
    requireObject(container, prefix);
    requireString(container.name, `${prefix}.name`);
    requireString(container.image, `${prefix}.image`);
    requireObject(container.resources, `${prefix}.resources`);
    requireObject(container.resources.requests, `${prefix}.resources.requests`);
    requireObject(container.resources.limits, `${prefix}.resources.limits`);

    if (container.ports !== undefined) {
      requireArray(container.ports, `${prefix}.ports`);
      for (const [portIndex, port] of container.ports.entries()) {
        requireNumberLike(port.containerPort, `${prefix}.ports[${portIndex}].containerPort`);
      }
    }
  }
}

function validateService(resource, location) {
  requireObject(resource.spec, `${location}: spec`);
  requireNonEmptyObject(resource.spec.selector, `${location}: spec.selector`);
  requireArray(resource.spec.ports, `${location}: spec.ports`);

  for (const [index, port] of resource.spec.ports.entries()) {
    const prefix = `${location}: spec.ports[${index}]`;
    requireObject(port, prefix);
    requireNumberLike(port.port, `${prefix}.port`);
    if (port.nodePort !== undefined) {
      requireNumberLike(port.nodePort, `${prefix}.nodePort`);
    }
    if (port.targetPort === undefined) {
      errors.push(`${prefix}: targetPort is required`);
    }
  }
}

function validatePersistentVolumeClaim(resource, location) {
  requireObject(resource.spec, `${location}: spec`);
  requireArray(resource.spec.accessModes, `${location}: spec.accessModes`);
  requireObject(resource.spec.resources, `${location}: spec.resources`);
  requireObject(resource.spec.resources.requests, `${location}: spec.resources.requests`);
  requireString(resource.spec.resources.requests.storage, `${location}: spec.resources.requests.storage`);
}

function validateCrossResourceLinks(manifests) {
  const hasNamespace = manifests.some(
    ({ resource }) => resource.kind === "Namespace" && resource.metadata?.name === expectedNamespace,
  );
  if (!hasNamespace) {
    errors.push(`infra/k8s: missing Namespace/${expectedNamespace}`);
  }

  const deployments = manifests
    .map(({ resource }) => resource)
    .filter((resource) => resource.kind === "Deployment");

  const services = manifests
    .map(({ resource }) => resource)
    .filter((resource) => resource.kind === "Service");

  for (const service of services) {
    const matchingDeployment = deployments.find((deployment) => {
      const labels = deployment.spec?.template?.metadata?.labels ?? {};
      return Object.entries(service.spec?.selector ?? {}).every(([key, value]) => labels[key] === value);
    });
    if (!matchingDeployment) {
      errors.push(`Service/${service.metadata.name}: selector does not match any Deployment template labels`);
    }
  }
}

function parseYaml(document) {
  const lines = document
    .split(/\r?\n/)
    .map((line, sourceIndex) => ({
      indent: countIndent(line),
      text: stripComment(line).trimEnd(),
      sourceIndex: sourceIndex + 1,
    }))
    .filter((line) => line.text.trim().length > 0);

  let index = 0;
  const result = parseBlock(0);
  if (index < lines.length) {
    throw new Error(`unexpected content on line ${lines[index].sourceIndex}`);
  }
  return result;

  function parseBlock(indent) {
    const line = lines[index];
    if (!line) {
      return null;
    }
    if (line.indent < indent) {
      return null;
    }
    return line.text.trimStart().startsWith("- ")
      ? parseSequence(indent)
      : parseMap(indent);
  }

  function parseMap(indent) {
    const map = {};
    while (index < lines.length) {
      const line = lines[index];
      if (line.indent < indent) {
        break;
      }
      if (line.indent > indent) {
        throw new Error(`unexpected indentation on line ${line.sourceIndex}`);
      }

      const text = line.text.trim();
      if (text.startsWith("- ")) {
        break;
      }

      const parsed = splitKeyValue(text, line.sourceIndex);
      index += 1;
      map[parsed.key] = parsed.hasValue
        ? parseScalar(parsed.value)
        : parseNestedValue(indent, line.sourceIndex);
    }
    return map;
  }

  function parseSequence(indent) {
    const sequence = [];
    while (index < lines.length) {
      const line = lines[index];
      if (line.indent < indent) {
        break;
      }
      if (line.indent > indent) {
        throw new Error(`unexpected indentation on line ${line.sourceIndex}`);
      }

      const text = line.text.trim();
      if (!text.startsWith("- ")) {
        break;
      }

      const itemText = text.slice(2).trim();
      index += 1;

      if (!itemText) {
        sequence.push(parseNestedValue(indent, line.sourceIndex));
        continue;
      }

      if (looksLikeKeyValue(itemText)) {
        const parsed = splitKeyValue(itemText, line.sourceIndex);
        const item = {
          [parsed.key]: parsed.hasValue
            ? parseScalar(parsed.value)
            : parseNestedValue(indent, line.sourceIndex),
        };
        while (index < lines.length && lines[index].indent > indent) {
          Object.assign(item, parseBlock(lines[index].indent));
        }
        sequence.push(item);
      } else {
        sequence.push(parseScalar(itemText));
      }
    }
    return sequence;
  }

  function parseNestedValue(parentIndent, sourceIndex) {
    if (index >= lines.length || lines[index].indent <= parentIndent) {
      return null;
    }
    return parseBlock(lines[index].indent, sourceIndex);
  }
}

function splitKeyValue(text, sourceIndex) {
  const separator = text.indexOf(":");
  if (separator <= 0) {
    throw new Error(`expected key/value mapping on line ${sourceIndex}`);
  }
  const key = text.slice(0, separator).trim();
  const value = text.slice(separator + 1).trim();
  return {
    key,
    value,
    hasValue: value.length > 0,
  };
}

function looksLikeKeyValue(text) {
  return /^[A-Za-z0-9_.-]+:\s*/.test(text);
}

function parseScalar(value) {
  if (value === "{}") {
    return {};
  }
  if (value === "[]") {
    return [];
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

function stripComment(line) {
  let quoted = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === '"' || character === "'") && line[index - 1] !== "\\") {
      quoted = quoted === character ? null : quoted ?? character;
    }
    if (character === "#" && !quoted && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function countIndent(line) {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
  }
}

function requireNonEmptyObject(value, label) {
  requireObject(value, label);
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
    errors.push(`${label} must not be empty`);
  }
}

function requireArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${label} must be a non-empty string`);
  }
}

function requireNumberLike(value, label) {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim().length === 0)) {
    errors.push(`${label} must be a number or named port string`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
