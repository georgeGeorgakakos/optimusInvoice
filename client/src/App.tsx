import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import InvoiceUpload from "./pages/InvoiceUpload";
import InvoiceList from "./pages/InvoiceList";
import InvoiceDetail from "./pages/InvoiceDetail";
import RuleLearning from "./pages/RuleLearning";
import KnowledgeBase from "./pages/KnowledgeBase";
import Configuration from "./pages/Configuration";
import Approvals from "./pages/Approvals";
import ErpDataModel from "./pages/ErpDataModel";
import Extractions from "./pages/Extractions";
import ClientProfilePage from "@/pages/ClientProfile";
// Processing Queue — live background-processing queue page. The route below
// (/queue) must have this import or the reference is undefined → blank page.
import ProcessingQueue from "./pages/ProcessingQueue";

function Router() {
    return (
        <Switch>
            <Route path={"/"} component={Home} />
            <Route path={"/dashboard"} component={Dashboard} />
            <Route path={"/invoices"} component={InvoiceList} />
            <Route path="/queue" component={ProcessingQueue} />
            <Route path={"/invoices/upload"} component={InvoiceUpload} />
            <Route path={"/invoices/:id"} component={InvoiceDetail} />
            <Route path={"/rules"} component={RuleLearning} />
            <Route path={"/knowledge-base"} component={KnowledgeBase} />
            <Route path={"/configuration"} component={Configuration} />
            <Route path={"/approvals"} component={Approvals} />
            <Route path={"/erp-model"} component={ErpDataModel} />
            <Route path={"/extractions"} component={Extractions} />
            <Route path={"/settings/client-profile"} component={ClientProfilePage} />
            <Route path={"/404"} component={NotFound} />
            <Route component={NotFound} />
        </Switch>
    );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
    return (
        <ErrorBoundary>
            <ThemeProvider
                defaultTheme="light"
            >
                <TooltipProvider>
                    <Toaster />
                    <Router />
                </TooltipProvider>
            </ThemeProvider>
        </ErrorBoundary>
    );
}

export default App;
