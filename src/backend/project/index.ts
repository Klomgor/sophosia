import { open } from "@tauri-apps/api/dialog";
import { exists, readDir, removeFile, renameFile } from "@tauri-apps/api/fs";
import { extname, join } from "@tauri-apps/api/path";
import {
  AnnotationData,
  Author,
  FolderOrNote,
  PDFState,
  Project,
  SpecialCategory,
  db,
} from "src/backend/database";
import { generateCiteKey } from "../meta";
import { getNoteTree, getNotes, renameFolder } from "../note";
import { pathToId } from "../utils";
import { projectFileAGUD } from "./fileOps";
import { projectSQLAGUD } from "./sqliteOps";
import { convertFileSrc } from "@tauri-apps/api/tauri";
import * as pdfjsLib from "pdfjs-dist";
import { TextItem } from "pdfjs-dist/types/src/display/api";
pdfjsLib.GlobalWorkerOptions.workerSrc = "pdfjs/pdf.worker.min.js"; // in the public folder
import { i18n } from "src/boot/i18n";
const { t } = i18n.global;

/**
 * Initializes a new project in a specified category.
 *
 * @param {string} category - The category path where the project is created.
 * @returns The newly created project object.
 *
 * Generates a project with a unique ID and default properties.
 */
export function createProject(category: string): Project {
  // create empty project entry
  const project = {
    _id: `SP${db.nanoid}`,
    timestampAdded: Date.now(),
    timestampModified: Date.now(),
    dataType: "project",
    label: t("new", { type: t("project") }),
    title: t("new", { type: t("project") }),
    path: undefined,
    tags: [] as string[],
    categories: ["library"],
    author: [] as Author[],
    favorite: false,
    children: [] as FolderOrNote[],
  } as Project;
  if (category != "library") project.categories.push(category);
  return project;
}

/**
 * Adds a new project to the database and creates its associated folder.
 *
 * @param {Project} project - The project to be added.
 * @returns {Project} project - The added project or undefined if an error occurs.
 *
 */
export async function addProject(
  project: Project
): Promise<Project | undefined> {
  try {
    // need to remomve _graph property if update by meta
    delete project._graph;
    // create actual folder for containing its files
    projectFileAGUD.createProjectFolder(project);
    // insert data into sqldb
    projectSQLAGUD.addProject(project);
    return project;
  } catch (err) {
    console.log(err);
  }
}

/**
 * Delete project from a category.
 * If deleteFromDB is true, delete the project from all categories
 * and remove the actual folder containing the project files in storage path
 * @param {string} projectId
 * @param {boolean} deleteFromDB
 * @param {string} category - if deleteFromDB === false, then we need category
 */
export async function deleteProject(
  projectId: string,
  deleteFromDB: boolean,
  category?: string
) {
  try {
    const project = (await getProject(projectId)) as Project;
    if (deleteFromDB) {
      // remove project and its related pdfState, pdfAnnotation and notes on db
      for (let dataType of ["pdfState", "pdfAnnotation"]) {
        const docs = await db.getDocs(dataType);
        for (const doc of docs) if (doc._id === projectId) await db.remove(doc);
      }

      // remove the acutual files
      await projectFileAGUD.deleteProjectFolder(projectId);
      await projectSQLAGUD.deleteProject(projectId);
    } else {
      if (category === undefined) throw new Error("category is needed");
      project.categories = project.categories.filter((id) => id != category);
      await updateProject(project._id, project);
    }
  } catch (err) {
    console.log(err);
  }
}

/**
 * Updates the properties of an existing project in the database.
 *
 * @param {string} projectId - The ID of the project to update.
 * @param {Project} props - An object with properties to update in the project.
 * @returns {Promise<Project | undefined>} The updated project or undefined if an error occurs.
 *
 */
export async function updateProject(
  projectId: string,
  props: Project
): Promise<Project | undefined> {
  try {
    const project = (await getProject(projectId)) as Project;
    Object.assign(project, props);
    project.timestampModified = Date.now();
    delete project._graph; // remomve _graph property if update by meta
    delete project.folderIds; // this property is removed since v0.17.0

    // project._id is the new id
    // projectId is the old id
    if (project._id !== projectId) {
      const oldPath = await join(db.config.storagePath, projectId);
      let newPath = await join(db.config.storagePath, project._id);
      // if citeKey duplicated, append nanoid
      if (await exists(newPath)) {
        project._id += db.nanoid;
        newPath = await join(db.config.storagePath, project._id);
      }

      // update projectIds in pdfState
      const states = (await db.getDocs("pdfState")) as PDFState[];
      for (const state of states) {
        if (state.projectId !== projectId) continue;
        state.projectId = project._id;
      }
      await db.bulkDocs(states);

      // update projectIds in pdfAnnotation
      const annots = (await db.getDocs("pdfAnnotation")) as AnnotationData[];
      for (const annot of annots) {
        if (annot.projectId !== projectId) continue;
        annot.projectId = project._id;
      }
      await db.bulkDocs(annots);

      // rename meta (don't change folder yet)
      await renameFile(
        await join(oldPath, `${projectId}.md`),
        await join(oldPath, `${project._id}.md`)
      );
      // rename projectFolder and update links in notes
      await renameFolder(projectId, project._id);
    }

    projectSQLAGUD.updateProject(projectId, project);
    projectFileAGUD.saveProjectNote(project);
    // add these back since the vue components need this
    project.path = await getPDF(project._id);
    project.children = await getNoteTree(project._id);
    return project;
  } catch (error) {
    console.log(error);
  }
}

/**
 * Retrieves a project from the database with optional inclusion of associated PDFs and notes.
 *
 * @param {string} projectId - The ID of the project to retrieve.
 * @param {Object} [options] - Options to include PDFs and/or notes in the project data.
 * @returns {Promise<Project | undefined>} The project with the specified ID, or undefined if not found or on error.
 *
 * Fetches the project and optionally attaches its associated PDF and note tree based on the provided options.
 */
export async function getProject(
  projectId: string,
  options?: { includePDF?: boolean; includeNotes?: boolean }
): Promise<Project | undefined> {
  try {
    const project = (await projectFileAGUD.loadProjectNote(
      projectId
    )) as Project;
    if (options?.includePDF) project.path = await getPDF(projectId);
    if (options?.includeNotes) project.children = await getNoteTree(projectId);
    return project;
  } catch (error) {
    console.log(error);
  }
}

/**
 * Retrieves all projects from the database, with options to include related PDFs and notes.
 *
 * @param {Object} [options] - Options to include associated PDFs and/or notes for each project.
 * @returns {Promise<Project[]>} A promise resolving to an array of Project objects.
 *
 * Iterates through all projects in the database, optionally attaching their associated PDF paths and note trees
 * based on the specified options.
 */
export async function getAllProjects(options?: {
  includePDF?: boolean;
  includeNotes?: boolean;
}): Promise<Project[]> {
  try {
    const projects = [] as Project[];
    const projectFolders = await readDir(db.config.storagePath);
    for (const folder of projectFolders) {
      // only read non-hidden folders
      if (folder.name!.startsWith(".")) continue;
      const project = await getProject(folder.name!);
      if (!project) continue; // skip this folder if it has not meta info
      if (options?.includePDF) project.path = await getPDF(project._id);
      if (options?.includeNotes) project.children = await getNotes(project._id);
      projects.push(project);
    }
    return projects;
  } catch (error) {
    console.log(error);
    return [];
  }
}

/**
 * Retrieves projects from a specific folder, with options to include related PDFs and notes.
 *
 * @param {string} category - The ID of the folder to filter projects by.
 * @param {Object} [options] - Options to include associated PDFs and/or notes for each project.
 * @returns {Promise<Project[]>} A promise resolving to an array of Project objects filtered by the folder ID.
 *
 * Fetches projects based on the specified folder ID, applying additional filters for special folders like Library, Added, and Favorites.
 * Optionally attaches associated PDF paths and note trees for each project based on provided options.
 */
export async function getProjects(
  category: string,
  options?: { includePDF?: boolean; includeNotes?: boolean }
): Promise<Project[]> {
  try {
    let projects = await getAllProjects();
    switch (category) {
      case SpecialCategory.LIBRARY:
        break;
      case SpecialCategory.ADDED:
        const date = new Date();
        // get recently added project in the last 30 days
        const timestamp = date.setDate(date.getDate() - 30);
        projects = projects.filter(
          (project) => project.timestampAdded > timestamp
        );
        // sort projects in descending order
        projects.sort((a, b) => b.timestampAdded - a.timestampAdded);
        break;
      case SpecialCategory.FAVORITES:
        projects = projects.filter((project) => project.favorite);
        break;
      default:
        projects = projects.filter((project) =>
          project.categories.includes(category)
        );
        break;
    }

    for (const project of projects) {
      if (options?.includePDF) project.path = await getPDF(project._id);
      if (options?.includeNotes)
        project.children = await getNoteTree(project._id);
    }

    return projects;
  } catch (error) {
    console.log(error);
    return [];
  }
}

/**
 * Renames the PDF file associated with a project based on a generated citation key.
 *
 * @param projectId - The project whose associated PDF needs renaming.
 * @returns The new path of the renamed PDF file or undefined if the project has no associated path.
 *
 * Generates a new filename using the citation key and moves the PDF file to this new path.
 */
export async function renamePDF(projectId: string, renameRule: string) {
  const project = await getProject(projectId, { includePDF: true });
  if (!project || project.path === undefined) return;
  const oldPath = project.path;
  const fileName = generateCiteKey(project, renameRule) + ".pdf";
  const newPath = await join(db.config.storagePath, project._id, fileName);
  await renameFile(oldPath, newPath);
  return newPath;
}

/**
 * Attaches a PDF file to a project by copying it to the project's folder.
 *
 * @param {string} projectId - The ID of the project to attach the PDF to.
 * @returns {Promise<string | undefined>} The path of the copied PDF file in the project's folder, or undefined if no file is selected.
 *
 * Opens a file dialog to select a PDF, removes any existing PDF associated with the project, and copies the selected PDF to the project's folder.
 */
export async function attachPDF(
  projectId: string
): Promise<string | undefined> {
  const filePath = await open({
    multiple: false,
    filters: [{ name: "*.pdf", extensions: ["pdf"] }],
  });

  if (typeof filePath !== "string") return;
  const oldPDFPath = await getPDF(projectId);
  if (oldPDFPath) await removeFile(oldPDFPath);
  return await projectFileAGUD.copyFileToProjectFolder(filePath, projectId);
}

/**
 * Retrieve the path of the first PDF file found within a project folder.
 *
 * @param projectId - The unique identifier of the project.
 * @returns The path of the first PDF file found, or undefined if no PDF is found or an error occurs.
 */
export async function getPDF(projectId: string) {
  try {
    const projectFolder = await join(db.config.storagePath, projectId);
    const entries = await readDir(projectFolder);
    for (const entry of entries) {
      try {
        if ((await extname(entry.path)) === "pdf") return entry.path;
      } catch (error) {}
    }
  } catch (error) {
    console.log(error);
  }
}

/**
 * Extract text from a PDF file
 *
 * @param {string} filePath - absolute path to the PDF
 */
export async function extractPDFContent(filePath: string) {
  const projectId = pathToId(filePath).split("/")[0];
  // const buffer = await readBinaryFile(filePath);
  const url = convertFileSrc(filePath);
  const pdf = await pdfjsLib.getDocument({ url }).promise;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    let page = await pdf.getPage(pageNumber);
    let content = await page.getTextContent();
    let text = content.items.map((item) => (item as TextItem).str).join("");
    projectSQLAGUD.insertContent(projectId, `${pageNumber}`, text);
    console.log("page", pageNumber, text);
  }
}
