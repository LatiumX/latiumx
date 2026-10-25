import { useAuth } from './auth';
import { Footer, Strip, TopBar } from './layout';
import { useRoute } from './router';
import { Agents, Blog, Freelance, Home, Login, Privacy, Terms } from './pages/static';
import { GigDetail, Hire, ProjectDetail, Projects, Services, UserProfile } from './pages/market';
import { Admin, Dashboard, Messages } from './pages/account';
import { ReportBug } from './pages/bugs';

function View({ route }: { route: string[] }) {
  const [page, a, b] = route;
  switch (page) {
    case 'home': return <Home />;
    case 'services': return <Services key={location.hash} />;
    case 'gig': return <GigDetail id={a} />;
    case 'projects': return <Projects />;
    case 'project': return <ProjectDetail id={a} />;
    case 'hire': return <Hire />;
    case 'freelance': return <Freelance />;
    case 'agents': return <Agents />;
    case 'blog': return <Blog />;
    case 'login': return <Login />;
    case 'u': return <UserProfile handle={a} />;
    case 'dashboard': return <Dashboard sub={a} arg={b} />;
    case 'messages': return <Messages id={a} />;
    case 'admin': return <Admin />;
    case 'bug': return <ReportBug />;
    case 'terms': return <Terms />;
    case 'privacy': return <Privacy />;
    default:
      return (
        <div className="page">
          <h1>Page not found</h1>
          <p className="muted" style={{ marginTop: 8 }}>That link doesn't go anywhere. <a href="#/">Go to the home page</a>.</p>
        </div>
      );
  }
}

export default function App() {
  const route = useRoute();
  const { error } = useAuth();
  return (
    <>
      <Strip />
      <TopBar route={route[0]} />
      <main className="gutter">
        <div className="wrap">
          {error && route[0] !== 'login' && <p className="err" role="alert" style={{ marginTop: 16 }}>{error}</p>}
          <View route={route} />
        </div>
      </main>
      <Footer />
    </>
  );
}
