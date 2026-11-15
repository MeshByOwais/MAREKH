/** Independent implementation of the uniform-grid, centre-cell interpolation
 * variant described by Ferguson & Stentz (2006). Costs belong to squares;
 * nodes are their corners. h=0 computes a complete reusable goal cost field.
 * This is not NASA flight source code. No bottom-cell shortcut or lookup table.
 */
export type FieldPoint = { row: number; column: number }
type Entry = { id: number; key: number; version: number }
class Queue {
  items: Entry[] = []
  less(a: Entry, b: Entry) { return a.key < b.key || (a.key === b.key && a.id < b.id) }
  push(v: Entry) {
    const a = this.items; let i = a.length; a.push(v)
    while (i) { const p = (i - 1) >> 1; if (!this.less(v, a[p])) break; a[i] = a[p]; i = p }; a[i] = v
  }
  pop() {
    const a = this.items, top = a[0], last = a.pop()!
    if (a.length) { let i = 0; while (2*i+1 < a.length) { let j=2*i+1; if (j+1<a.length && this.less(a[j+1],a[j])) j++; if (!this.less(a[j],last)) break; a[i]=a[j];i=j };a[i]=last }
    return top
  }
}
const same = (a: number, b: number) => a === b || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) <= 1e-10)

// Minimise c*sqrt(1+t²) + (1-t)*gCardinal + t*gDiagonal.
// The continuous t is the distinguishing interpolation step, not a graph edge.
export function interpolatedCost(c: number, gCardinal: number, gDiagonal: number) {
  if (!Number.isFinite(c)) return { cost: Infinity, fraction: 0 }
  if (!Number.isFinite(gCardinal)) return { cost: c*Math.SQRT2+gDiagonal, fraction: 1 }
  if (!Number.isFinite(gDiagonal) || gCardinal <= gDiagonal) return { cost: c+gCardinal, fraction: 0 }
  const f=gCardinal-gDiagonal
  const t=f >= c ? 1 : Math.min(1,f/Math.sqrt(c*c-f*f))
  return { cost:c*Math.hypot(1,t)+(1-t)*gCardinal+t*gDiagonal, fraction:t }
}

export class FieldDStar {
  readonly g: Float64Array
  readonly rhs: Float64Array
  private versions: Uint32Array
  private queue = new Queue()
  processed = 0
  constructor(readonly rows: number, readonly columns: number, readonly spacingM: number, readonly costs: Float64Array, readonly goal: FieldPoint) {
    if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 2 || columns < 2 || costs.length !== (rows-1)*(columns-1) || !Number.isFinite(spacingM) || spacingM <= 0) throw new Error('Invalid Field D* grid')
    if (!Number.isInteger(goal.row) || !Number.isInteger(goal.column) || goal.row < 0 || goal.column < 0 || goal.row >= rows || goal.column >= columns) throw new Error('Field D* goal outside grid')
    if (costs.some(c => c !== Infinity && (!Number.isFinite(c) || c < 1))) throw new Error('Field costs must be >= 1 or positive Infinity')
    this.g=new Float64Array(rows*columns).fill(Infinity); this.rhs=new Float64Array(this.g);this.versions=new Uint32Array(this.g.length)
    const id=goal.row*columns+goal.column;this.rhs[id]=0;this.enqueue(id)
  }
  private enqueue(id: number) {
    const version=++this.versions[id]
    if (!same(this.g[id],this.rhs[id])) this.queue.push({id,key:Math.min(this.g[id],this.rhs[id]),version})
  }
  private successors(id: number) {
    const row=Math.floor(id/this.columns),col=id%this.columns
    let best={cost:Infinity,row,column:col}
    // Eight consecutive cardinal/diagonal neighbour pairs around this node.
    for (const dr of [-1,1]) for (const dc of [-1,1]) {
      const qr=row+(dr<0?-1:0),qc=col+(dc<0?-1:0)
      if (qr<0 || qc<0 || qr>=this.rows-1 || qc>=this.columns-1) continue
      const cost=this.costs[qr*(this.columns-1)+qc]*this.spacingM
      const diag=(row+dr)*this.columns+col+dc
      for (const axis of [0,1]) {
        const cr=row+(axis===0?dr:0),cc=col+(axis===1?dc:0)
        const v=interpolatedCost(cost,this.g[cr*this.columns+cc],this.g[diag])
        if (v.cost<best.cost) best={cost:v.cost,row:cr+(row+dr-cr)*v.fraction,column:cc+(col+dc-cc)*v.fraction}
      }
    }
    return best
  }
  private update(id: number) {
    if (id !== this.goal.row*this.columns+this.goal.column) this.rhs[id]=this.successors(id).cost
    this.enqueue(id)
  }
  private neighbours(id: number, includeSelf: boolean) {
    const row=Math.floor(id/this.columns),col=id%this.columns
    for (let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++) {
      const r=row+dr,c=col+dc
      if ((!includeSelf && !dr && !dc)||r<0||c<0||r>=this.rows||c>=this.columns)continue
      this.update(r*this.columns+c)
    }
  }
  compute(maxPops = 30_000_000) {
    let pops=0
    while(this.queue.items.length) {
      if (++pops>maxPops) throw new Error('Field D* convergence budget exceeded; no route published')
      const e=this.queue.pop()
      if (e.version!==this.versions[e.id] || same(this.g[e.id],this.rhs[e.id]))continue
      if (this.g[e.id]>this.rhs[e.id]) {this.g[e.id]=this.rhs[e.id];this.neighbours(e.id,false)}
      else {this.g[e.id]=Infinity;this.neighbours(e.id,true)}
      this.processed++
    }
  }
  updateCost(row: number, column: number, value: number) {
    if (!Number.isInteger(row)||!Number.isInteger(column)||row<0||column<0||row>=this.rows-1||column>=this.columns-1||!(value===Infinity || Number.isFinite(value)&&value>=1))throw new Error('Invalid Field D* cost update')
    this.costs[row*(this.columns-1)+column]=value
    for(const dr of [0,1])for(const dc of [0,1])this.update((row+dr)*this.columns+column+dc)
  }
  nodeSuccessor(row: number,column: number) {return this.successors(row*this.columns+column)}

  /** Query an arbitrary point using direct travel to a surrounding square edge
   * followed by linearly interpolated node costs. No smoothing of blocked cells.
   */
  query(p: FieldPoint) {
    let best={cost:Infinity,row:p.row,column:p.column}
    if (p.row===this.goal.row && p.column===this.goal.column)return {cost:0,...p}
    const candidates=new Set<number>()
    for(const r of [Math.floor(p.row-1e-8),Math.floor(p.row+1e-8)])for(const c of [Math.floor(p.column-1e-8),Math.floor(p.column+1e-8)]) {
      if(r>=0&&c>=0&&r<this.rows-1&&c<this.columns-1)candidates.add(r*(this.columns-1)+c)
    }
    for(const id of candidates) {
      const r=Math.floor(id/(this.columns-1)),c=id%(this.columns-1),density=this.costs[id]
      if(!Number.isFinite(density))continue
      const corners=[{row:r,column:c},{row:r,column:c+1},{row:r+1,column:c+1},{row:r+1,column:c}]
      for(let i=0;i<4;i++) {
        const a=corners[i],b=corners[(i+1)%4],ga=this.g[a.row*this.columns+a.column],gb=this.g[b.row*this.columns+b.column]
        const value=(t:number)=>density*this.spacingM*Math.hypot(a.row+(b.row-a.row)*t-p.row,a.column+(b.column-a.column)*t-p.column)+(t===0?ga:t===1?gb:(1-t)*ga+t*gb)
        // Convex one-dimensional objective; include exact endpoint candidates.
        let lo=0,hi=1
        if(Number.isFinite(ga)&&Number.isFinite(gb))for(let j=0;j<32;j++) {
          const t1=(2*lo+hi)/3,t2=(lo+2*hi)/3
          if(value(t1)<=value(t2))hi=t2;else lo=t1
        }
        for(const t of [0,1,(lo+hi)/2]) {
          const cost=value(t)
          if(cost<best.cost)best={cost,row:a.row+(b.row-a.row)*t,column:a.column+(b.column-a.column)*t}
        }
      }
    }
    return best
  }
}
