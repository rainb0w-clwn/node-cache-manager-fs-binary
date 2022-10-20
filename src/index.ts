import type {Config, Store} from 'cache-manager';
import {glob} from 'glob';
import {v4 as uuidV4} from 'uuid';

import {existsSync, mkdirSync, statSync} from 'fs';
import {readdir, readFile, unlink, writeFile} from 'fs/promises';
import {join, resolve} from 'path';
import {promisify} from 'util';
import {deflate, unzip} from 'zlib';

type WithRequired<T, K extends keyof T> = Required<Pick<T, K>> & Exclude<T, K>;
type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

type KeyExpiredTuple = [string, number];

export type FsBinaryValueBinaryKeyType = Buffer | string
export type FsBinaryValueBinaryType<T extends FsBinaryValueBinaryKeyType = FsBinaryValueBinaryKeyType> = Record<string, T>
export type FsBinaryValueBinary<T extends FsBinaryValueBinaryKeyType = FsBinaryValueBinaryKeyType> = {
  binary: FsBinaryValueBinaryType<T>;
  [K: string]: any;
}
export type FsBinaryValue<T extends FsBinaryValueBinaryKeyType = FsBinaryValueBinaryKeyType> =
  string
  | Buffer
  | FsBinaryValueBinary<T>;

export type FsBinaryMetaData = {
  key: string,
  size: number;
  filename: string,
  expires: number,
}

export type FsBinaryMetaFromFile = FsBinaryMetaData & {
  value: string | FsBinaryValueBinaryType<string>
}

export type FsBinaryConfig = {
  maxsize?: number /* max size in bytes on disk */,
  path?: string,  // path for cached files
  preventfill?: boolean,  // prevent filling of the cache with the files from the cache-directory
  zip?: boolean, // if true the main cache files will be zipped (not the binary ones)
  fillcallback?: (err?: any) => void, //  callback fired after the initial cache filling is completed
} & Config

export interface FsBinaryStore extends Store {
  get: <T = FsBinaryMetaFromFile>(key: string) => Promise<T | undefined>,
  set: <T = FsBinaryValue<Buffer>>(key: string, data: T, ttl?: number) => Promise<void>
  collection: Record<string, FsBinaryMetaData>,
  currentsize: number,
  options: WithRequired<FsBinaryConfig, 'ttl' | 'path' | 'isCacheable'>,
  isCacheableValue: (value: unknown) => boolean;
  cleancache: () => Promise<void>;
  zipIfNeeded: (data: Buffer | string) => Promise<Buffer | string>,
  unzipIfNeeded: (data: Buffer) => Promise<Buffer>,
  cleanExpired: () => Promise<void>,
  freeupspace: () => Promise<void>
  freeupspacehelper: (tuples: KeyExpiredTuple[]) => Promise<void>
  intializefill: () => Promise<void>,
}

export function fsBinaryStore(args?: FsBinaryConfig): FsBinaryStore {
  const options: WithRequired<FsBinaryConfig, 'ttl' | 'path' | 'isCacheable'> = {
    ...args,
    ttl: args?.ttl ?? 60,
    path: args?.path ?? 'cache',
    isCacheable: args?.isCacheable || ((value: any) => value !== undefined && value !== null && (Buffer.isBuffer(value) || typeof value == 'string' || (typeof value == 'object' && value.binary))),
  };

  // check storage directory for existence (or create it)
  if (!existsSync(options.path)) {
    mkdirSync(options.path);
  }
  const store = {
    collection: {},
    currentsize: 0,
    options,
    async get(key: string): Promise<FsBinaryMetaFromFile | undefined> {
      // get the metadata from the collection
      const data = this.collection[key];
      if (!data) {
        // not found
        return undefined;
      }
      if (data.expires < Date.now()) {
        // delete the element from the store
        return this.del(key).then(() => undefined);
      }
      return readFile(data.filename)
        .then(this.unzipIfNeeded)
        .then(buffer => JSON.parse(buffer.toString()) as FsBinaryMetaFromFile);
    },
    async mget(...args) {
      return args.map(x => this.get(x));
    },
    async mset(args, ttl) {
      await Promise.all(args.map(([key, value]) => {
        if (!options.isCacheable(value)) {
          throw new Error(`no cacheable value ${JSON.stringify(value)}`);
        }
        return this.set(key, value, ttl);
      }));
    },
    async mdel(...args) {
      await Promise.all(args.map(x => this.del(x)));
    },
    async set(key: string, data: FsBinaryValue<Buffer>, ttl?: number) {
      if (!options.isCacheable(data)) {
        throw new Error(`no cacheable value ${JSON.stringify(data)}`);
      }
      ttl = (ttl || ttl === 0) ? ttl : options.ttl;

      const fileName = `cache_${uuidV4()}.dat`;
      const filePath = resolve(join(options.path, fileName));

      const metaData: FsBinaryMetaFromFile = {
        key: key,
        value: filePath.replace(/\.dat$/,  '.bin'),
        expires: Date.now() + (ttl * 1000),
        filename: filePath,
        size: 0,
      };

      let binarySize = 0;
      let binary: string | Buffer | FsBinaryValueBinaryType<Buffer> | undefined;
      if (!(typeof data == 'string') && !(data instanceof Buffer)) {
        if (data.binary) {
          binary = data.binary;
          delete (data as Optional<FsBinaryValueBinary<Buffer>, 'binary'>).binary;
          data.binary = {};
          if (!Buffer.isBuffer(binary)) {
            for (const binkey in binary) {
              // put storage filenames into stored value.binary object
              if (typeof metaData.value == 'string') {
                metaData.value = {};
              }
              metaData.value[binkey] = metaData.filename.replace(/\.dat$/, '_' + binkey + '.bin');
              // calculate the size of the binary data
              binarySize += binary[binkey].length || 0;
            }
          }
        }
      } else {
        binary = data;
        binarySize += binary.length;
      }

      const stream = JSON.stringify(metaData);

      metaData.size = stream.length + binarySize;

      if (options.maxsize && metaData.size > options.maxsize) {
        throw new Error('Item size too big.');
      }


      // remove the key from the cache (if it already existed, this updates also the current size of the store)
      await this.del(key)
        .then(() => this.freeupspace())
        .then(() => Promise.all(
          binary
            ? typeof binary == 'object' && 'binary' in binary && !(typeof metaData.value === 'string')
              ? Object.entries(binary).map(([k, v]) => writeFile((metaData.value as FsBinaryValueBinary<string>)[k], v))
              : (typeof metaData.value === 'string') && (typeof binary == 'string' || Buffer.isBuffer(binary))
                ? [writeFile(metaData.value, binary)]
                : []
            : [],
        ),
        )
        .then(() => this.zipIfNeeded(Buffer.from(stream)))
        .then(processedStream => writeFile(metaData.filename, processedStream))
        .then(() => {
          // remove data value from memory
          const metaDataWithOptionalValue = metaData as Optional<FsBinaryMetaFromFile, 'value'>;
          metaDataWithOptionalValue.value = undefined;
          delete metaDataWithOptionalValue.value;
          this.currentsize += metaData.size;
          // place element with meta info in internal collection
          this.collection[metaData.key] = metaData;
        });
    },

    async del(key: string) {
      // get the meta information for the key
      const metaData = this.collection[key];
      if (!metaData) {
        return;
      }
      // check if the filename is set
      if (!metaData.filename) {
        return;
      }
      // check for existance of the file
      return readFile(metaData.filename)
        .then(this.unzipIfNeeded)
        .then(async (metaExtraContent) => {
          if (!metaExtraContent) {
            throw new Error('No meta');
          }
          let metaData: FsBinaryMetaFromFile;
          try {
            metaData = JSON.parse(metaExtraContent.toString());
          } catch (e) {
            throw new Error('Parsing meta error');
          }

          if (metaData?.value && !(typeof metaData.value === 'string')) {
            // unlink binaries
            for (key of Object.keys(metaData.value)) {
              await unlink(metaData.value[key]);
            }
          }
          return unlink(metaData.filename);
        })
        .then(() => {
          this.currentsize -= metaData.size;
          this.collection[key] = null as any;
          delete this.collection[key];
          return;
        });
    },
    async ttl(key: string) {
      const now = Date.now();
      const expires = this.collection[key]?.expires;
      return expires
        ? expires < now
          ? 0
          : expires - now
        : options.ttl;
    },
    async keys() {
      return Object.keys(this.collection);
    },
    async reset() {
      const keys = await this.keys();
      if (keys.length == 0) {
        return;
      }
      await Promise.all(keys.map(key => this.del(key)));
    },
    isCacheableValue: options.isCacheable,
    name: 'fsBinary',
    async cleanExpired() {
      for (const key in this.collection) {
        const entry = this.collection[key];
        if (entry.expires <= Date.now()) {
          await this.del(entry.key);
        }
      }
    },
    async cleancache() {
      // clean all current used files
      await this.reset();

      // check, if other files still resist in the cache and clean them, too
      await readdir(options.path)
        .then(files => Promise.all(
          files
            .map(file => join(options.path, file))
            .filter(filePath => statSync(filePath).isFile())
            .map(filePath => unlink(filePath).catch()),
        ),
        );
    },
    async zipIfNeeded(data: Buffer): Promise<Buffer> {
      if (options.zip) {
        return promisify(deflate)(data);
      }
      return data;
    },
    async unzipIfNeeded(data: Buffer): Promise<Buffer> {
      if (options.zip) {
        return await promisify(unzip)(data);
      }
      return data;
    },
    async intializefill(): Promise<void> {
      await readdir(options.path)
        .then(files => Promise.all(
          files
            .map(file => resolve(join(options.path, file)))
            .filter(filePath => statSync(filePath).isFile())
            .filter(filePath => /\.dat$/.test(filePath))
            .map((filePath) => {
              return readFile(filePath)
                .then(this.unzipIfNeeded)
                .then((data) => {
                  // get the json out of the data
                  const diskData: FsBinaryMetaData = JSON.parse(data.toString());

                  // update the size in the metadata - this value isn't correctly stored in the file
                  // diskData.size = data.length;
                  // update collection size
                  this.currentsize += diskData.size;

                  // and put the entry in the store
                  this.collection[diskData.key] = diskData;

                  // check for expiry - in this case we instantly delete the entry
                  if (diskData.expires < Date.now()) {
                    return store.del(diskData.key);
                  }
                })
                .catch(() => {
                  unlink(filePath)
                    .then(() => promisify(glob)(filePath.replace(/\.dat$/, '*.bin')))
                    .then(files => Promise.all(files.map(f => unlink(f).catch())))
                    .catch();
                });
            }),
        ),
        );
    },
    async freeupspacehelper (tuples: KeyExpiredTuple[]): Promise<void> {
      // check, if we have any entry to process
      if (tuples.length === 0) {
        return;
      }
      // get an entry from the list
      const tuple = tuples.pop();
      if (tuple) {
        const key = tuple[0];
        // delete an entry from the store
        return store.del(key).then(() => {
          // stop processing when enouth space has been cleaned up
          if (options.maxsize == null || (this.currentsize <= options.maxsize)) {
            return;
          }
          // ok - we need to free up more space
          return this.freeupspacehelper(tuples);
        });
      }
      return;
    },
    async freeupspace(): Promise<void> {
      if (!options.maxsize) {
        return;
      }
      // do we use too much space? then cleanup first the expired elements
      if (this.currentsize > options.maxsize) {
        await store.cleanExpired();
      }

      // when the space usage is too high, remove the oldest entries until we gain enough disks pace
      if (this.currentsize <= options.maxsize) {
        return;
      }

      // for this we need a sorted list based on the expiry date of the entries (descending)
      const tuples: [string, number][] = [];
      for (const key in this.collection) {
        tuples.push([key, this.collection[key].expires]);
      }

      tuples.sort((a, b) => {
        const a1 = a[1];
        const b1 = b[1];
        return a1 < b1 ? 1 : (a1 > b1 ? -1 : 0);
      });
      return this.freeupspacehelper(tuples);
    },
  } as FsBinaryStore;

  if (!options.preventfill) {
    store.intializefill().then(options.fillcallback);
  }
  return store;
}
