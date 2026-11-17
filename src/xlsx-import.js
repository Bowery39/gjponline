import { posix } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

const maxXmlBytes=8*1024*1024;

function archive(buffer) {
  let end=buffer.length-22;
  while (end>=Math.max(0,buffer.length-65557)) {
    if (buffer.readUInt32LE(end)===0x06054b50&&end+22+buffer.readUInt16LE(end+20)===buffer.length) break;
    end--;
  }
  if (end<0||buffer.readUInt32LE(end)!==0x06054b50) throw Error('无效的 Excel 工作簿');
  const count=buffer.readUInt16LE(end+10);
  const entries=new Map();
  let offset=buffer.readUInt32LE(end+16);
  for (let index=0;index<count;index++) {
    if (offset+46>end||buffer.readUInt32LE(offset)!==0x02014b50) throw Error('Excel 文件目录无效');
    const length=buffer.readUInt16LE(offset+28);
    const name=buffer.toString('utf8',offset+46,offset+46+length);
    entries.set(name,{
      flags:buffer.readUInt16LE(offset+8),method:buffer.readUInt16LE(offset+10),
      crc:buffer.readUInt32LE(offset+16),compressed:buffer.readUInt32LE(offset+20),
      size:buffer.readUInt32LE(offset+24),local:buffer.readUInt32LE(offset+42)
    });
    offset+=46+length+buffer.readUInt16LE(offset+30)+buffer.readUInt16LE(offset+32);
  }
  return name=>{
    const entry=entries.get(name);
    if (!entry) return '';
    if (entry.size>maxXmlBytes) throw Error('Excel 工作表内容过大');
    const {local}=entry;
    if ((entry.flags&1)||local+30>buffer.length||buffer.readUInt32LE(local)!==0x04034b50) throw Error('无法读取 Excel 文件');
    const start=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28);
    if (start+entry.compressed>buffer.length||![0,8].includes(entry.method)) throw Error('无法读取 Excel 文件');
    const raw=buffer.subarray(start,start+entry.compressed);
    const content=entry.method===0?raw:inflateRawSync(raw,{maxOutputLength:maxXmlBytes});
    if (content.length!==entry.size||crc32(content)!==entry.crc) throw Error('Excel 文件已损坏');
    return content.toString('utf8');
  };
}

function decode(text) {
  const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,value)=>{
    if (value[0]!=='#') return entities[value]??'';
    const code=value[1].toLowerCase()==='x'?Number('0x'+value.slice(2)):Number(value.slice(1));
    return code<=0x10ffff?String.fromCodePoint(code):'';
  }).replace(/_x([\da-f]{4})_/gi,(_,value)=>String.fromCharCode(Number('0x'+value)));
}
const attribute=(tag,key)=>decode(tag.match(new RegExp('(?:^|\\s)'+key+'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')'))?.slice(1).find(value=>value!==undefined)??'');
const stringValue=xml=>[...xml.replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g,'').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match=>decode(match[1])).join('');

export function readWorkbookRows(buffer,maxRows) {
  const read=archive(buffer);
  const workbook=read('xl/workbook.xml');
  const first=workbook.match(/<sheet\b([^>]*)\/?\s*>/);
  if (!first) throw Error('Excel 文件没有工作表');
  const id=attribute(first[1],'r:id');
  const relationship=[...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)>/g)]
    .find(match=>attribute(match[1],'Id')===id);
  if (!relationship||attribute(relationship[1],'TargetMode')==='External') throw Error('找不到第一个工作表');
  const target=attribute(relationship[1],'Target');
  const worksheet=read(target.startsWith('/')?target.slice(1):posix.join('xl',target));
  const data=worksheet.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/)?.[1];
  if (!data) throw Error('第一个工作表没有数据');
  const shared=[...read('xl/sharedStrings.xml').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(match=>stringValue(match[1]));
  const rows=[];
  for (const [,content] of data.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (!content) continue;
    const row=[];
    for (const [,tag,cell=''] of content.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const letters=attribute(tag,'r').match(/^[A-Z]+/)?.[0];
      const column=letters?[...letters].reduce((n,letter)=>n*26+letter.charCodeAt(0)-64,0)-1:row.length;
      if (column>255) throw Error('导入工作表最多支持 256 列');
      const type=attribute(tag,'t');
      const value=decode(cell.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1]??'');
      row[column]=type==='inlineStr'?stringValue(cell):type==='s'?shared[Number(value)]??'':value;
    }
    if (row.some(value=>value.trim())) rows.push(Array.from(row,value=>value??''));
    if (rows.length>maxRows) throw Error('工作表行数超过导入上限');
  }
  return rows;
}
