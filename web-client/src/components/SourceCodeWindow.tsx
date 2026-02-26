import { useState, useEffect } from 'react';
import type { Instance } from '../types';

interface SourceCodeWindowProps {
  instance: Instance | null;
}

// Mock source code for demonstration
const mockSourceCode: Record<string, string> = {
  'top_module': `module top_module (
  input wire clk,
  input wire rst_n,
  input wire [31:0] data_in,
  output reg [31:0] data_out
);

  // Internal signals
  reg [3:0] state;
  reg [15:0] counter;

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

  // Bus arbiter
  bus_arbiter u_bus (
    .clk(clk),
    .master_req(master_req),
    .grant(grant)
  );

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      state <= 4'h0;
      counter <= 16'h0;
      data_out <= 32'h0;
    end else begin
      state <= state + 1;
      counter <= counter + 1;
      data_out <= data_in + counter;
    end
  end

endmodule`,
  'cpu': `module cpu (
  input wire clk,
  input wire rst_n,
  output reg [31:0] pc,
  input wire [31:0] instr
);

  reg [31:0] alu_result;
  wire reg_write_en;

  // ALU instance
  alu u_alu (
    .a(a),
    .b(b),
    .op(op),
    .result(result),
    .zero(zero)
  );

  // Register file
  regfile u_regfile (
    .clk(clk),
    .read_addr1(read_addr1),
    .read_addr2(read_addr2),
    .write_addr(write_addr),
    .write_data(write_data),
    .write_en(write_en),
    .read_data1(read_data1),
    .read_data2(read_data2)
  );

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      pc <= 32'h0;
    end else begin
      pc <= pc + 4;
    end
  end

endmodule`,
  'memory': `module memory (
  input wire clk,
  input wire [15:0] addr,
  input wire [31:0] data_in,
  output reg [31:0] data_out,
  input wire we
);

  reg [31:0] mem [0:65535];

  always @(posedge clk) begin
    if (we) begin
      mem[addr] <= data_in;
    end
    data_out <= mem[addr];
  end

endmodule`,
  'bus_arbiter': `module bus_arbiter (
  input wire clk,
  input wire [3:0] master_req,
  output reg [3:0] grant
);

  reg [2:0] arbiter_state;

  always @(posedge clk) begin
    case (arbiter_state)
      3'd0: grant <= 4'b0001;
      3'd1: grant <= 4'b0010;
      3'd2: grant <= 4'b0100;
      3'd3: grant <= 4'b1000;
      default: grant <= 4'b0000;
    endcase
    arbiter_state <= arbiter_state + 1;
  end

endmodule`,
  'alu': `module alu (
  input wire [31:0] a,
  input wire [31:0] b,
  input wire [3:0] op,
  output reg [31:0] result,
  output reg zero
);

  always @(*) begin
    case (op)
      4'h0: result = a + b;
      4'h1: result = a - b;
      4'h2: result = a & b;
      4'h3: result = a | b;
      4'h4: result = a ^ b;
      default: result = 32'h0;
    endcase
    zero = (result == 32'h0);
  end

endmodule`,
  'regfile': `module regfile (
  input wire clk,
  input wire [4:0] read_addr1,
  input wire [4:0] read_addr2,
  input wire [4:0] write_addr,
  input wire [31:0] write_data,
  input wire write_en,
  output reg [31:0] read_data1,
  output reg [31:0] read_data2
);

  reg [31:0] regs [0:31];

  always @(posedge clk) begin
    if (write_en) begin
      regs[write_addr] <= write_data;
    end
  end

  always @(*) begin
    read_data1 = regs[read_addr1];
    read_data2 = regs[read_addr2];
  end

endmodule`,
};

export function SourceCodeWindow({ instance }: SourceCodeWindowProps) {
  const [content, setContent] = useState<string>('');
  const [moduleName, setModuleName] = useState<string>('');

  useEffect(() => {
    if (instance) {
      const code = mockSourceCode[instance.moduleName] || '';
      setContent(code);
      setModuleName(instance.moduleName);
    } else {
      setContent('');
      setModuleName('');
    }
  }, [instance]);

  const renderCode = () => {
    if (!content) {
      return (
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center', 
          height: '100%',
          color: '#999',
          fontSize: '12px',
        }}>
          Select an instance to view source code
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
      <div style={{
        height: '22px',
        background: 'linear-gradient(to bottom, #e0e8f0, #c0d0e0)',
        borderBottom: '1px solid #a0b0c0',
        display: 'flex',
        alignItems: 'center',
        padding: '0 6px',
        fontSize: '11px',
        fontWeight: 600,
      }}>
        {moduleName ? `Source: ${moduleName}.v` : 'Source Code'}
      </div>
      {renderCode()}
    </div>
  );
}
