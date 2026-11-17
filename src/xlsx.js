import { crc32, deflateRawSync } from 'node:zlib';

const xml = value => String(value)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,'')
  .replace(/_x[0-9a-f]{4}_/gi,match=>'_x005F_'+match.slice(1))
  .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\r','&#13;');

function columnName(index) {
  let name='';
  for (let column=index+1;column>0;column=Math.floor((column-1)/26)) {
    name=String.fromCharCode(65+(column-1)%26)+name;
  }
  return name;
}

function cell(value,reference) {
  const start='<c r="'+reference+'"';
  if (typeof value==='number'&&Number.isFinite(value)) return start+'><v>'+value+'</v></c>';
  if (typeof value==='boolean') return start+' t="b"><v>'+Number(value)+'</v></c>';
  return start+' t="inlineStr"><is><t xml:space="preserve">'+xml(value??'')+'</t></is></c>';
}

function zip(files) {
  const entries=[], directory=[];
  let offset=0, directorySize=0;
  for (const [path, contents] of files) {
    const name=Buffer.from(path);
    const raw=Buffer.from(contents);
    const compressed=deflateRawSync(raw);
    const header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20,4);
    header.writeUInt16LE(8,8);
    header.writeUInt16LE(33,12);
    header.writeUInt32LE(crc32(raw),14);
    header.writeUInt32LE(compressed.length,18);
    header.writeUInt32LE(raw.length,22);
    header.writeUInt16LE(name.length,26);
    entries.push(header,name,compressed);

    const index=Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE(20,4);
    header.copy(index,6,4,30);
    index.writeUInt32LE(offset,42);
    directory.push(index,name);
    offset+=header.length+name.length+compressed.length;
    directorySize+=index.length+name.length;
  }
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length,8);
  end.writeUInt16LE(files.length,10);
  end.writeUInt32LE(directorySize,12);
  end.writeUInt32LE(offset,16);
  return Buffer.concat([...entries,...directory,end]);
}

export function xlsx(columns,rows) {
  const sheet=[columns,...rows].map((row,index)=>{
    const number=index+1;
    return '<row r="'+number+'">'+row.map((value,column)=>cell(value,columnName(column)+number)).join('')+'</row>';
  }).join('');
  const workbook='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const relationships='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const packageRelationships='http://schemas.openxmlformats.org/package/2006/relationships';
  return zip([
    ['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels','<Relationships xmlns="'+packageRelationships+'"><Relationship Id="rId1" Type="'+relationships+'/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml','<workbook xmlns="'+workbook+'" xmlns:r="'+relationships+'"><sheets><sheet name="导出数据" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels','<Relationships xmlns="'+packageRelationships+'"><Relationship Id="rId1" Type="'+relationships+'/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml','<worksheet xmlns="'+workbook+'"><sheetData>'+sheet+'</sheetData></worksheet>']
  ]);
}
