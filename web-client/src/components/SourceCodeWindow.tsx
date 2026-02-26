import { useState, useEffect } from 'react';

interface SourceCodeWindowProps {
  filePath: string | null;
}

// Mock source code for demonstration
const mockSourceCode: Record<string, string> = {
  'top.v': `module top (
  input wire clk,
  input wire rst_n,
  output reg [31:0] data_out
);

  // CPU instance
  cpu u_cpu (
    .clk(clk),
    .rst_n(rst_n),
    .pc(pc),
    .instr(instr)
  );

  // Memory instance
  memory u_mem (
    .clk(clk),
    .addr(addr),
    .data(data)
  );

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      data_out <= 32'h0;
    end else begin
      data_out <= data_out + 1;
    end
  end

endmodule`,
};

export function SourceCodeWindow({ filePath }: SourceCodeWindowProps) {
  const [content, setContent] = useState<string>('');
  const [, setLineNumbers] = useState<number[]>([]);

  useEffect(() => {
    if (filePath && mockSourceCode[filePath]) {
      const code = mockSourceCode[filePath];
      setContent(code);
      setLineNumbers(Array.from({ length: code.split('\n').length }, (_, i) => i + 1));
    } else {
      setContent('');
      setLineNumbers([]);
    }
  }, [filePath]);

  const renderCode = () => {
    if (!content) {
      return (
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center', 
          height: '100%',
          color: '#999'
        }}>
          Select a file to view source code
        </div>
      );
    }

    const lines = content.split('\n');

    return (
      <div className="code-editor">
        {lines.map((line, index) => (
          <div key={index} className="code-line">
            <div className="code-line-number">{index + 1}</div>
            <div className="code-line-content">{line || ' '}</div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="panel-header">
        {filePath ? `Source: ${filePath}` : 'Source Code'}
      </div>
      {renderCode()}
    </div>
  );
}
