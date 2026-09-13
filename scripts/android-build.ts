import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = join(workspaceRoot, "apps/android");
const cacheRoot = join(workspaceRoot, ".cache/android-toolchain");
const webAssets = join(androidRoot, "app/src/main/assets/web");
const online = process.argv.includes("--online");
const outputRoot = join(
  workspaceRoot,
  online ? "artifacts/android-online" : "artifacts/android",
);
const debug = process.argv.includes("--debug");
const variant = debug ? "debug" : "release";
const buildEnvironment = { ...process.env };

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function run(
  executable: string,
  args: string[],
  cwd = workspaceRoot,
): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: buildEnvironment,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`${executable} exited with ${String(code)}`)),
    );
  });
}

async function pnpm(args: string[]): Promise<void> {
  const cli = process.env.npm_execpath;
  if (!cli || !/pnpm\.(?:m?js|cjs)$/i.test(cli))
    throw new Error(
      "Run this script with pnpm android:build or pnpm android:debug.",
    );
  await run(process.execPath, [cli, ...args]);
}

async function localJavaHome(): Promise<string> {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const local = join(cacheRoot, "jdk");
  if (await exists(local)) {
    const folders = await readdir(local);
    for (const folder of folders) {
      if (
        await exists(
          join(
            local,
            folder,
            "bin",
            process.platform === "win32" ? "java.exe" : "java",
          ),
        )
      )
        return join(local, folder);
    }
  }
  throw new Error("Set JAVA_HOME to JDK 17 or 21; see docs/ANDROID.md.");
}

const javaHome = await localJavaHome();
const java = join(
  javaHome,
  "bin",
  process.platform === "win32" ? "java.exe" : "java",
);
const sdk =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  join(cacheRoot, "sdk");
if (!(await exists(join(sdk, "platforms/android-35/android.jar"))))
  throw new Error("Android SDK platform 35 is missing; see docs/ANDROID.md.");
buildEnvironment.JAVA_HOME = javaHome;
buildEnvironment.ANDROID_HOME = sdk;
buildEnvironment.ANDROID_USER_HOME = join(cacheRoot, "android-user");
buildEnvironment.GRADLE_USER_HOME =
  process.env.GRADLE_USER_HOME ?? join(cacheRoot, "gradle-user");

if (!debug && !process.env.DEARVALE_ANDROID_KEYSTORE) {
  const signingRoot = join(
    workspaceRoot,
    online ? ".cache/android-signing-online" : ".cache/android-signing",
  );
  const credentialsPath = join(signingRoot, "credentials.json");
  await mkdir(signingRoot, { recursive: true });
  let credentials: { password: string; alias: string };
  if (await exists(credentialsPath)) {
    credentials = JSON.parse(
      await readFile(credentialsPath, "utf8"),
    ) as typeof credentials;
    if (
      typeof credentials.password !== "string" ||
      credentials.password.length < 16 ||
      credentials.alias !== "dearvale"
    )
      throw new Error("Invalid local signing credentials.");
  } else {
    credentials = {
      password: randomBytes(32).toString("base64url"),
      alias: "dearvale",
    };
    await writeFile(credentialsPath, JSON.stringify(credentials), {
      flag: "wx",
      mode: 0o600,
    });
  }
  const keystore = join(signingRoot, "dearvale-release.jks");
  buildEnvironment.DEARVALE_ANDROID_KEYSTORE = keystore;
  buildEnvironment.DEARVALE_ANDROID_STORE_PASSWORD = credentials.password;
  buildEnvironment.DEARVALE_ANDROID_KEY_PASSWORD = credentials.password;
  buildEnvironment.DEARVALE_ANDROID_KEY_ALIAS = credentials.alias;
  if (!(await exists(keystore))) {
    await run(
      join(
        javaHome,
        "bin",
        process.platform === "win32" ? "keytool.exe" : "keytool",
      ),
      [
        "-genkeypair",
        "-keystore",
        keystore,
        "-storetype",
        "JKS",
        "-alias",
        credentials.alias,
        "-keyalg",
        "RSA",
        "-keysize",
        "3072",
        "-validity",
        "10000",
        "-dname",
        "CN=Dearvale Local Distribution, OU=Mobile, O=Dearvale",
        "-storepass:env",
        "DEARVALE_ANDROID_STORE_PASSWORD",
        "-keypass:env",
        "DEARVALE_ANDROID_KEY_PASSWORD",
        "-noprompt",
      ],
    );
  }
}

if (!online && !process.argv.includes("--skip-web"))
  await pnpm(["--filter", "@personasim/web", "build"]);
if (!online && !(await exists(join(workspaceRoot, "apps/web/dist/index.html"))))
  throw new Error("Build apps/web before packaging.");
const assetRelative = relative(androidRoot, webAssets);
if (
  isAbsolute(assetRelative) ||
  assetRelative.startsWith(`..${sep}`) ||
  assetRelative === ".."
)
  throw new Error("Invalid generated asset target.");
if (!online) {
  await rm(webAssets, { recursive: true, force: true });
  await mkdir(webAssets, { recursive: true });
  await cp(join(workspaceRoot, "apps/web/dist"), webAssets, {
    recursive: true,
  });
}

const wrapperJar = join(androidRoot, "gradle/wrapper/gradle-wrapper.jar");
const gradleHome = process.env.GRADLE_HOME ?? join(cacheRoot, "gradle-8.11.1");
const localGradleJar = join(
  gradleHome,
  "lib/gradle-gradle-cli-main-8.11.1.jar",
);
let launcher: string[];
if (await exists(localGradleJar)) {
  launcher = ["-classpath", localGradleJar, "org.gradle.launcher.GradleMain"];
} else if (await exists(wrapperJar)) {
  launcher = ["-classpath", wrapperJar, "org.gradle.wrapper.GradleWrapperMain"];
} else {
  throw new Error("Gradle 8.11.1 wrapper is missing; see docs/ANDROID.md.");
}
await run(
  java,
  [
    ...launcher,
    "--no-daemon",
    "--console=plain",
    ...(online ? ["-PdearvaleOnline=true"] : []),
    "testDebugUnitTest",
    `lint${debug ? "Debug" : "Release"}`,
    `assemble${debug ? "Debug" : "Release"}`,
  ],
  androidRoot,
);
const apkOutputRoot = join(androidRoot, `app/build/outputs/apk/${variant}`);
// Gradle's artifact metadata is generated from app/build.gradle, keeping the
// APK's manifest, filename and build receipt on one version source.
const outputMetadata = JSON.parse(
  await readFile(join(apkOutputRoot, "output-metadata.json"), "utf8"),
) as {
  applicationId: string;
  elements: Array<{
    versionCode: number;
    versionName: string;
    outputFile: string;
  }>;
};
const apkMetadata = outputMetadata.elements[0];
const appId = online ? "app.dearvale.mobile.online" : "app.dearvale.mobile";
if (
  outputMetadata.applicationId !== appId ||
  outputMetadata.elements.length !== 1 ||
  !apkMetadata ||
  !Number.isSafeInteger(apkMetadata.versionCode) ||
  apkMetadata.versionCode < 1 ||
  !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(apkMetadata.versionName) ||
  apkMetadata.outputFile !== `app-${variant}.apk`
)
  throw new Error("Unexpected Android APK artifact metadata.");
const builtApk = join(apkOutputRoot, apkMetadata.outputFile);
if (!(await exists(builtApk)))
  throw new Error(
    "A signed APK was not produced. Check signing configuration.",
  );
await mkdir(outputRoot, { recursive: true });
const outputApk = join(
  outputRoot,
  `Dearvale${online ? "-Online" : ""}-${apkMetadata.versionName}${debug ? "-debug" : ""}.apk`,
);
await cp(builtApk, outputApk);
await run(java, [
  "-jar",
  join(sdk, "build-tools/35.0.0/lib/apksigner.jar"),
  "verify",
  "--verbose",
  "--print-certs",
  outputApk,
]);
const apkBytes = await readFile(outputApk);
const sha256 = createHash("sha256").update(apkBytes).digest("hex");
await writeFile(
  `${outputApk}.sha256.txt`,
  `${sha256}  ${outputApk.split(/[\\/]/u).at(-1)}\n`,
);
const buildInfo =
  JSON.stringify(
    {
      appId,
      version: apkMetadata.versionName,
      versionCode: apkMetadata.versionCode,
      variant,
      builtAt: new Date().toISOString(),
      apkBytes: apkBytes.length,
      sha256,
      minSdk: 26,
      targetSdk: 35,
      bundledWebIndexSha256: online
        ? null
        : createHash("sha256")
            .update(await readFile(join(webAssets, "index.html")))
            .digest("hex"),
      serverRequired: true,
    },
    null,
    2,
  ) + "\n";
await writeFile(`${outputApk}.build-info.json`, buildInfo);
await writeFile(
  join(outputRoot, `build-info${debug ? "-debug" : ""}.json`),
  buildInfo,
);
console.log(
  `\nSigned APK: ${outputApk}\nSHA-256: ${sha256}\nRequires a running Dearvale computer or HTTPS server; see docs/ANDROID.md.`,
);
