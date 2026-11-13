import { readFile, mkdir, writeFile } from "node:fs/promises";

const root = new URL("../vendor/pointee/", import.meta.url);
const upstream = JSON.parse(await readFile(new URL("UPSTREAM.json", root), "utf8"));
for (const file of upstream.files) {
  const response = await fetch(`https://raw.githubusercontent.com/Jingquank/pointee/${upstream.commit}/${file}`);
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  const target = new URL(file, root);
  await mkdir(new URL("./", target), { recursive: true });
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
  console.log(`Vendored ${file}`);
}
