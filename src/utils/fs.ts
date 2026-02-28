import path from 'path'
import fs from 'fs'
import { File } from 'formidable';

export const getProjectFile = (file: string) => {
  const filePath = path.resolve(process.cwd(), file);
  return fs.readFileSync(filePath, { encoding: 'utf-8' })
}
export const getProjectJsonFile = (file: string) => {
  const filePath = path.resolve(process.cwd(), file);
  return getJsonFile(filePath)
}

export const getJsonFile = async (filePath: string) => {
  const exist = await checkExist(filePath)
  if (!exist) return {}
  const content = fs.readFileSync(filePath, { encoding: 'utf-8' })
  try {
    return JSON.parse(content)
  } catch (error) {
    return {}
  }
}

export const writeJsonFile = async (filePath: string, format: (data: any) => any, space: number = 2) => {
  const data = await getJsonFile(filePath)
  fs.writeFileSync(filePath, JSON.stringify(format(data), null, space))
}

export const checkExist = (path: string) => {
  return new Promise((resolve, reject) => {
    fs.access(path, (err) => {
      resolve(!err)
    })
  });
}
export type CreateDirOption = {
  // 基础路径，默认肯定存在，不会进行检测
  basePath?: string
}

export const writeFile = async (path: string, content: string, basePath?: string) => {
  const isExist = await checkExist(path);
  if (isExist) return console.log("⚠️ 文件已存在：", path);

  const pathArr = path.split('/')
  const fileName = pathArr[pathArr.length - 1];
  const dirPath = path.replace(RegExp(`${fileName}$`), '')

  await createDir(dirPath, { basePath })

  fs.writeFileSync(path, content, 'utf8');
}
export const createDir = async (path: string, options?: CreateDirOption) => {
  let { basePath = '' } = options || {};
  if (!RegExp(`^${basePath}`).test(path)) {
      console.warn('传入多路径不是以', basePath, '开头，配置无效！');
  }
  const checkDirPath = path.replace(basePath, '').replace(/^\//, '');
  const paths = checkDirPath.split('/');

  while (paths.length) {
      const path = paths.shift();
      const fullPath = `${basePath}/${path}`
      const isExist = await checkExist(fullPath);
      try {
          if (!isExist) fs.mkdirSync(fullPath)
      } catch (error) {
        // @ts-ignore
        if (error && error.message && !error.message.includes('file already exists')) {
          // @ts-ignore
            throw new Error(error)
        }
      } finally {
          basePath = fullPath
      }
  }
}
export const createFile = async (path: string, file: File, basePath?: string) => {
  const isExist = await checkExist(path);
  if (isExist) return console.log("⚠️ 文件已存在：", path);

  const pathArr = path.split('/')
  const fileName = pathArr[pathArr.length - 1];
  const dirPath = path.replace(RegExp(`${fileName}$`), '')

  await createDir(dirPath, { basePath })

  return new Promise((resolve, reject) => {
    // @ts-ignore
    const render = fs.createReadStream(file.path);
    const upStream = fs.createWriteStream(path);
    render.pipe(upStream);

    let errFlag = false;
    upStream.on('error', err => {
        errFlag = true;
        upStream.destroy();
        reject(err);
    })
    upStream.on('finish', () => {
        if (errFlag) return;
        resolve("finish")
        upStream.close();
    })
  });
}


/**
 * 获取文件夹下的所有文件路径
 * @param {PathLike} dir 文件夹路径
 * @returns 文件夹中所有文件路径集合
 */
export async function readDirFilePath(dir: string, options?: { exclude?: string[] }) {
  const { exclude } = options || {}
  return new Promise<string[]>((resolve, reject) => {
    let filesPath: string[] = [];
    fs.readdir(dir, { withFileTypes: true }, async (err, files) => {
      if (err) reject(err)

      while(files.length) {
        const item = files.pop();
        if (!item) continue

        if (item.isDirectory()) {
          const childPaths = await readDirFilePath(`${dir}/${item.name}`);
          filesPath = [...filesPath, ...childPaths];
          continue;
        }
        if (exclude?.length && exclude.find(str => item.name.includes(str))) continue;
        filesPath.push(`${dir}/${item.name}`)
      }
      resolve(filesPath);
    });
  })
}

/**
 * 获取文件夹下的所有文件夹路径
 * @param {PathLike} dir 文件夹路径
 * @returns 文件夹中所文件夹路径集合
 */
export async function readDirs(dir: string, options?: { level: number, excludes: string[] }, currentLevel: number = 1) {
  const { level = 1, excludes } = options || {}
  return new Promise<{ name: string, path: string }[]>((resolve, reject) => {
    let filesPath: { name: string, path: string }[] = [];
    fs.readdir(dir, { withFileTypes: true }, async (err, files) => {
      if (err) reject(err)
      while (files.length) {
        const item = files.pop();
        if (!item) continue

        if (item.isDirectory()) {
          const path = `${/(.*)\/$/.test(dir) ? dir.slice(0, -1) : dir}/${item.name}`
          filesPath.push({ name: item.name, path })
          if (currentLevel >= level || excludes?.includes(item.name)) continue
          const childPaths = await readDirs(path, options, currentLevel + 1);
          filesPath = [...filesPath, ...childPaths];
          continue;
        }
      }
      resolve(filesPath);
    });
  })
}

export function find(path: string, reg?: any, recursive: boolean = false){ 
  const files = fs.readdirSync(path);
  const res: string[] = [];
  files.forEach(file => {
    if(recursive && fs.statSync(file).isDirectory()){
      res.concat(find(path+'/'+file, reg, recursive))
    }
    if(reg.test(file)){
      res.push(path+'/'+file)
    }
  })
  return res
}