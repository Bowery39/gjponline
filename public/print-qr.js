// QR byte mode, versions 1–5, error correction L and mask 0.
export function qrMatrix(text) {
  const bytes=new TextEncoder().encode(text);
  const capacities=[19,34,55,80,108],ecc=[7,10,15,20,26];
  const version=capacities.findIndex(cap=>bytes.length+2<=cap)+1;
  if(!version)throw Error('二维码最多支持 106 个 UTF-8 字节');
  const data=[],append=(value,count)=>{for(let i=count-1;i>=0;i--)data.push(value>>>i&1);};
  append(4,4);append(bytes.length,8);
  for(const byte of bytes)append(byte,8);
  const length=capacities[version-1]*8;
  append(0,Math.min(4,length-data.length));
  while(data.length%8)data.push(0);
  let pad=0;
  while(data.length<length)append(pad++%2?0x11:0xec,8);
  const words=Array.from({length:data.length/8},(_,i)=>data.slice(i*8,i*8+8).reduce((a,b)=>a*2+b,0));
  const multiply=(a,b)=>{let result=0;for(let i=0;i<8;i++){if(b&1)result^=a;b>>>=1;a<<=1;if(a&256)a^=0x11d;}return result;};
  const degree=ecc[version-1],generator=new Array(degree).fill(0);generator[degree-1]=1;
  let root=1;
  for(let i=0;i<degree;i++){for(let j=0;j<degree;j++){generator[j]=multiply(generator[j],root);if(j+1<degree)generator[j]^=generator[j+1];}root=multiply(root,2);}
  const remainder=new Array(degree).fill(0);
  for(const word of words){const factor=word^remainder.shift();remainder.push(0);for(let i=0;i<degree;i++)remainder[i]^=multiply(generator[i],factor);}
  const bits=[...words,...remainder].flatMap(word=>Array.from({length:8},(_,i)=>word>>>(7-i)&1));
  const size=version*4+17,m=Array.from({length:size},()=>Array(size).fill(false)),reserved=m.map(row=>row.slice());
  const set=(x,y,value)=>{if(x>=0&&y>=0&&x<size&&y<size){m[y][x]=!!value;reserved[y][x]=true;}};
  for(const [cx,cy] of [[3,3],[size-4,3],[3,size-4]])for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){
    const distance=Math.max(Math.abs(dx),Math.abs(dy));set(cx+dx,cy+dy,distance!==2&&distance!==4);
  }
  for(let i=8;i<size-8;i++){set(i,6,i%2===0);set(6,i,i%2===0);}
  if(version>1){const center=size-7;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)set(center+dx,center+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);}
  // L + mask 0 produces the BCH-protected format word 0x77c4.
  const format=0x77c4,bit=i=>(format>>>i)&1;
  for(let i=0;i<=5;i++)set(8,i,bit(i));
  set(8,7,bit(6));set(8,8,bit(7));set(7,8,bit(8));
  for(let i=9;i<15;i++)set(14-i,8,bit(i));
  for(let i=0;i<8;i++)set(size-1-i,8,bit(i));
  for(let i=8;i<15;i++)set(8,size-15+i,bit(i));
  set(8,size-8,true);
  let index=0,up=true;
  for(let right=size-1;right>=1;right-=2){
    if(right===6)right=5;
    for(let step=0;step<size;step++){
      const y=up?size-1-step:step;
      for(let offset=0;offset<2;offset++){
        const x=right-offset;
        if(!reserved[y][x])m[y][x]=!!((bits[index++]||0)^((x+y)%2===0?1:0));
      }
    }
    up=!up;
  }
  return m;
}
export function qrSvg(text) {
  const matrix=qrMatrix(text),size=matrix.length+8;
  const path=matrix.flatMap((row,y)=>row.flatMap((dark,x)=>dark?['M'+(x+4)+','+(y+4)+'h1v1h-1z']:[])).join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+size+' '+size+'" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="'+path+'" fill="black"/></svg>';
}
