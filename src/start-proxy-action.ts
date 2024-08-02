import { ChildProcess, spawn } from "child_process";
import * as path from "path";

import * as core from "@actions/core";
import * as toolcache from "@actions/tool-cache";
import { pki } from "node-forge";

import * as actionsUtil from "./actions-util";
import * as util from "./util";
import { getActionsLogger, Logger } from "./logging";

const UPDATEJOB_PROXY = "update-job-proxy";
const UPDATEJOB_PROXY_VERSION = "v2.0.20240722180912";
const UPDATEJOB_PROXY_URL =
  "https://github.com/github/codeql-action/releases/download/codeql-bundle-v2.18.1/update-job-proxy.tar.gz";
const PROXY_USER = "proxy_user";
const KEY_SIZE = 2048;
const KEY_EXPIRY_YEARS = 2;

export type CertificateAuthority = {
  cert: string;
  key: string;
};

export type Credential = {
  type: string;
  host: string;
  username?: string;
  password?: string;
  token?: string;
};

export type BasicAuthCredentials = {
  username: string;
  password: string;
};

export type ProxyConfig = {
  all_credentials: Credential[];
  ca: CertificateAuthority;
  proxy_auth?: BasicAuthCredentials;
};

const CERT_SUBJECT = [
  {
    name: "commonName",
    value: "Dependabot Internal CA",
  },
  {
    name: "organizationName",
    value: "GitHub inc.",
  },
  {
    shortName: "OU",
    value: "Dependabot",
  },
  {
    name: "countryName",
    value: "US",
  },
  {
    shortName: "ST",
    value: "California",
  },
  {
    name: "localityName",
    value: "San Francisco",
  },
];

function generateCertificateAuthority(): CertificateAuthority {
  const keys = pki.rsa.generateKeyPair(KEY_SIZE);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(
    cert.validity.notBefore.getFullYear() + KEY_EXPIRY_YEARS,
  );

  cert.setSubject(CERT_SUBJECT);
  cert.setIssuer(CERT_SUBJECT);
  cert.setExtensions([{ name: "basicConstraints", cA: true }]);
  cert.sign(keys.privateKey);

  const pem = pki.certificateToPem(cert);
  const key = pki.privateKeyToPem(keys.privateKey);
  return { cert: pem, key };
}

async function runWrapper() {
  const logger = getActionsLogger();

  // Setup logging for the proxy
  const tempDir = actionsUtil.getTemporaryDirectory();
  const proxyLogFilePath = path.resolve(tempDir, "proxy.log");
  core.saveState("proxy-log-file", proxyLogFilePath);

  // Get the configuration options
  const credentials = getCredentials();
  logger.debug(`Credentials loaded for the following URLs:\n ${credentials.map(c => c.host).join("\n")}`)

  const ca = generateCertificateAuthority();
  const proxyAuth = getProxyAuth();

  const proxyConfig: ProxyConfig = {
    all_credentials: credentials,
    ca,
    proxy_auth: proxyAuth,
  };

  // Start the Proxy
  const proxyBin = await getProxyBinaryPath();
  await startProxy(proxyBin, proxyConfig, proxyLogFilePath, logger);
}

async function startProxy(binPath: string, config: ProxyConfig, logFilePath: string, logger: Logger) {
  const host = "127.0.0.1";
  let port = 49152;
  try {
    let subprocess: ChildProcess | undefined = undefined;
    let tries = 5;
    let subprocessError: Error | undefined = undefined;
    while (tries-- > 0 && !subprocess && !subprocessError) {
      subprocess = spawn(
        binPath,
        ["-addr", `${host}:${port}`, "-config", "-", "-logfile", logFilePath],
        {
          detached: true,
          stdio: ["pipe", "ignore", "ignore"],
        },
      );
      subprocess.unref();
      if (subprocess.pid) {
        core.saveState("proxy-process-pid", `${subprocess.pid}`);
      }
      subprocess.on("error", (error) => {
        subprocessError = error;
      });
      subprocess.on("exit", (code) => {
        if (code !== 0) {
          // If the proxy failed to start, try a different port from the ephemeral range [49152, 65535]
          port = Math.floor(Math.random() * (65535 - 49152) + 49152);
          subprocess = undefined;
        }
      });
      subprocess.stdin?.write(JSON.stringify(config));
      subprocess.stdin?.end();
      // Wait a little to allow the proxy to start
      await util.delay(1000);
    }
    if (subprocessError) {
      throw subprocessError;
    }
    logger.info(`Proxy started on ${host}:${port}`);
    core.setOutput("proxy_host", host);
    core.setOutput("proxy_port", port.toString());
    core.setOutput("proxy_ca_certificate", config.ca.cert);
  } catch (error) {
    core.setFailed(
      `start-proxy action failed: ${util.wrapError(error).message}`,
    );
  }
}

// getCredentials returns registry credentials from action inputs.
// It prefers `registries_credentials` over `registry_secrets`.
// If neither is set, it returns an empty array.
function getCredentials(): Credential[] {
  const encodedCredentials = actionsUtil.getOptionalInput("registries_credentials");
  if (encodedCredentials !== undefined) {
    const credentialsStr = Buffer.from(encodedCredentials, "base64").toString();
    return JSON.parse(credentialsStr) as Credential[];
  }
  core.info(`Using structured credentials.`);
  const registrySecrets = actionsUtil.getOptionalInput("registry_secrets") || "[]";
  return JSON.parse(registrySecrets) as Credential[];
}

// getProxyAuth returns the authentication information for the proxy itself.
function getProxyAuth(): BasicAuthCredentials | undefined{
  const proxy_password = actionsUtil.getOptionalInput("proxy_password");
  if (proxy_password) {
    return {
      username: PROXY_USER,
      password: proxy_password,
    };
  }
  return ;
}


async function getProxyBinaryPath(): Promise<string> {
  let proxyBin = toolcache.find(UPDATEJOB_PROXY, UPDATEJOB_PROXY_VERSION);
  if (!proxyBin) {
    const temp = await toolcache.downloadTool(UPDATEJOB_PROXY_URL);
    const extracted = await toolcache.extractTar(temp);
    proxyBin = await toolcache.cacheDir(
      extracted,
      UPDATEJOB_PROXY,
      UPDATEJOB_PROXY_VERSION,
    );
  }
  proxyBin = path.join(proxyBin, UPDATEJOB_PROXY);
  return proxyBin;
}

void runWrapper();
