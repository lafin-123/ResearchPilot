export function annotationFixturePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    '',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  const content1='BT /F1 16 Tf 60 720 Td (ResearchPilot annotation fixture) Tj 0 -35 Td /F1 12 Tf (A reproducible experiment preserves its evidence.) Tj 0 -24 Td (Highlight this sentence and attach a local comment.) Tj ET'
  const content2='BT /F1 16 Tf 60 720 Td (Second page: limitations) Tj 0 -35 Td /F1 12 Tf (A highlight is a reading record, not verified evidence.) Tj ET'
  objects[3]=`<< /Length ${Buffer.byteLength(content1)} >>\nstream\n${content1}\nendstream`
  objects[5]=`<< /Length ${Buffer.byteLength(content2)} >>\nstream\n${content2}\nendstream`
  let output='%PDF-1.4\n';const offsets=[0]
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`}
  const xref=Buffer.byteLength(output);output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(output,'ascii')
}
