// Feasible upper witnesses on the native planar surface. This graph is NOT
// the continuous optimality certificate; independently verified potentials are.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <queue>
#include <stdexcept>
#include <string>
#include <vector>
using namespace std;
struct Point {double r,c,z;};
struct Node {Point p;vector<int> faces;};
struct Face {vector<int> nodes;};
double length(Point a,Point b,double spacing){return hypot(spacing*hypot(a.r-b.r,a.c-b.c),a.z-b.z);}
int main(int argc,char**argv){try{
  if(argc<2)throw runtime_error("Usage: global_grade_portals WORK_DIR [elevation_step_m]");
  string dir=argv[1];int nv,nf,start,goal;double spacing,budget,step;
  ifstream header(dir+"/mesh.txt");if(!(header>>nv>>nf>>start>>goal>>spacing>>budget>>step))throw runtime_error("Invalid mesh header");
  if(argc>2)step=stod(argv[2]);if(!(step>0))throw runtime_error("Invalid portal spacing");
  vector<Point> vertices(nv);ifstream vin(dir+"/vertices.f64",ios::binary);vin.read(reinterpret_cast<char*>(vertices.data()),nv*sizeof(Point));
  vector<array<int32_t,3>> triangles(nf);ifstream fin(dir+"/upper-faces.i32",ios::binary);fin.read(reinterpret_cast<char*>(triangles.data()),nf*3*sizeof(int32_t));
  if(!vin||!fin)throw runtime_error("Incomplete mesh");
  vector<Node> nodes;nodes.reserve(nv*10);for(auto p:vertices)nodes.push_back({p,{}});
  vector<Face> faces;faces.reserve(nf);map<pair<int,int>,vector<int>> portals;
  for(auto tri:triangles){
    vector<int> ids(tri.begin(),tri.end());
    for(int k=0;k<3;k++){
      int a=tri[k],b=tri[(k+1)%3];if(a>b)swap(a,b);auto key=make_pair(a,b);auto it=portals.find(key);
      if(it==portals.end()){
        vector<int> edge;Point p=vertices[a],q=vertices[b];
        double lo=min(p.z,q.z),hi=max(p.z,q.z);
        // Elevation portals preserve contour crossings across shared triangles.
    if(hi-lo>1e-12)for(int64_t j=int64_t(ceil(lo/step));j<=int64_t(floor(hi/step));j++){
          if(nodes.size()>=4500000)throw runtime_error("Portal resource limit reached; reduce the distance search area. Continuous infeasibility is not established");
          double t=(j*step-p.z)/(q.z-p.z);if(t<1e-8||t>1-1e-8)continue;
          edge.push_back(nodes.size());nodes.push_back({{p.r+t*(q.r-p.r),p.c+t*(q.c-p.c),p.z+t*(q.z-p.z)}, {}});
        }
        // Midpoints improve resolution on almost-level edges.
        edge.push_back(nodes.size());nodes.push_back({{(p.r+q.r)/2,(p.c+q.c)/2,(p.z+q.z)/2},{}});
        it=portals.emplace(key,move(edge)).first;
      }
      ids.insert(ids.end(),it->second.begin(),it->second.end());
    }
    sort(ids.begin(),ids.end());ids.erase(unique(ids.begin(),ids.end()),ids.end());
    int f=faces.size();faces.push_back({ids});for(int i:ids)nodes[i].faces.push_back(f);
  }
  cerr<<"Mesh: "<<nodes.size()<<" portals, "<<faces.size()<<" faces, elevation step "<<step<<" m\n";
  vector<double> dist(nodes.size()),heuristic(nodes.size()),chord(nodes.size());vector<int> parent(nodes.size());size_t expanded=0;
  for(size_t i=0;i<nodes.size();i++)chord[i]=length(nodes[i].p,nodes[goal].p,spacing);
  auto search=[&](double cap){
    fill(dist.begin(),dist.end(),numeric_limits<double>::infinity());fill(parent.begin(),parent.end(),-1);
    using Q=pair<double,int>;priority_queue<Q,vector<Q>,greater<Q>> queue;
    double sine=sin(cap*acos(-1.)/180.);
    double tangent=tan(cap*acos(-1.)/180.),tangent2=tangent*tangent,spacing2=spacing*spacing;
    for(size_t i=0;i<nodes.size();i++)heuristic[i]=max(chord[i],abs(nodes[i].p.z-nodes[goal].p.z)/sine);
    dist[start]=0;queue.push({heuristic[start],start});expanded=0;
    while(!queue.empty()){
      auto [score,i]=queue.top();queue.pop();auto p=nodes[i].p;
      if(score>dist[i]+heuristic[i]+1e-9)continue;
      if(score>budget+1e-9)return false;
      if(i==goal)return true;expanded++;
      for(int f:nodes[i].faces)for(int j:faces[f].nodes){
        if(i==j)continue;auto q=nodes[j].p;
        double dr=q.r-p.r,dc=q.c-p.c,dz=q.z-p.z,h2=spacing2*(dr*dr+dc*dc);
        if(dz*dz>h2*tangent2+1e-15)continue;
        double w=sqrt(h2+dz*dz);if(w<1e-9)continue;
        double next=dist[i]+w;
        if(next>=dist[j]-1e-10)continue;
        double h=heuristic[j];if(next+h>budget+1e-9)continue;
        dist[j]=next;parent[j]=i;queue.push({next+h,j});
      }
    }
    return false;
  };
  // Optional fixed cap uses the same admissible A* and minimizes 3D length.
  // A graph failure is not proof of continuous infeasibility.
  bool fixed=argc>3&&string(argv[3])=="shortest";
  double low=0,high=argc>4?stod(argv[4]):20;
  double tolerance=argc>5?stod(argv[5]):.001;
  if(!(high>0&&high<=20&&tolerance>0))throw runtime_error("Invalid grade cap or tolerance");
  if(!search(high))throw runtime_error("No budget-feasible portal witness at the requested grade limit; continuous infeasibility is not established");
  while(!fixed&&high-low>tolerance){double mid=(low+high)/2;bool ok=search(mid);cerr<<setprecision(9)<<mid<<" deg: "<<(ok?dist[goal]:-1)<<" m, "<<expanded<<" expanded\n";if(ok)high=mid;else low=mid;}
  if(!search(high))throw runtime_error("Failed to repeat upper witness");
  vector<int> path;for(int i=goal;i!=-1;i=parent[i])path.push_back(i);reverse(path.begin(),path.end());
  ofstream out(dir+"/witness.json");out<<setprecision(17)<<"{\"needsGradeRealization\":"<<"false"<<",\"gradeCapDeg\":"<<high<<",\"oneWayDistanceM\":"<<dist[goal]<<",\"portalElevationStepM\":"<<step<<",\"portalCount\":"<<nodes.size()<<",\"faceCount\":"<<faces.size()<<",\"expanded\":"<<expanded<<",\"points\":[";
  bool first=true;for(int i:path){auto p=nodes[i].p;if(!first)out<<",";first=false;out<<"{\"row\":"<<p.r<<",\"column\":"<<p.c<<"}";}out<<"]}\n";
  cerr<<"Saved witness: "<<high<<" deg, "<<2*dist[goal]<<" m round trip, "<<path.size()<<" points\n";
}catch(const exception&e){cerr<<e.what()<<"\n";return 1;}return 0;}
