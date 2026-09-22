// jobNimbus.client.ts

import {
  CompanyCamChecklist,
  CompanyCamComments,
  CompanyCamOrganization,
  CompanyCamPhotos,
  CompanyCamProjectFiles,
  CompanyCamProjectLabels,
  CompanyCamProjectNotes,
  CompanyCamProjects,
  CompanyCamUser,
} from "../../../utils/interfaces/integrations";

export class CompanyCamClient {
  private apiKey: string;
  private apiBaseUrl = "https://api.companycam.com/v2";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async makeRequest<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `CompanyCam API error: ${response.status} - ${errorText}`,
      );
    }

    return response.json();
  }

  async getCompanyInfo() {
    try {
      const response = await this.makeRequest<CompanyCamOrganization>(
        `${this.apiBaseUrl}/company`,
      );
      return response;
    } catch (error) {
      throw new Error(`Failed to fetch company info: ${error.message}`);
    }
  }

  async getUserList(page?: number, perPage?: number) {
    try {
      let url = `${this.apiBaseUrl}/users`;
      if (page && perPage) {
        url += `?page=${page}&per_page=${perPage}`;
      }
      const response = await this.makeRequest<CompanyCamUser[]>(url);
      return response;
    } catch (error) {
      throw new Error(`Failed to fetch user list: ${error.message}`);
    }
  }

  async getAllUsers() {
    try {
      const allUsers: CompanyCamUser[] = [];
      let page = 1;
      const perPage = 100; // Maximum allowed by CompanyCam API
      let hasMorePages = true;

      while (hasMorePages) {
        const response = await this.getUserList(page, perPage);

        if (response && response.length > 0) {
          allUsers.push(...response);
          page++;
        } else {
          // Empty response means no more pages
          hasMorePages = false;
        }
      }

      return allUsers.filter((user) => user.status != "deleted");
    } catch (error) {
      throw new Error(`Failed to fetch all users: ${error.message}`);
    }
  }

  async getProjectsList(page?: number, perPage?: number) {
    try {
      let url = `${this.apiBaseUrl}/projects`;
      if (page && perPage) {
        url += `?page=${page}&per_page=${perPage}`;
      }
      const response = await this.makeRequest<CompanyCamProjects[]>(url);
      return response;
    } catch (error) {
      throw new Error(`Failed to fetch project list: ${error.message}`);
    }
  }

  async getAllProjects() {
    try {
      const allProjects: CompanyCamProjects[] = [];
      let page = 1;
      const perPage = 50; // Maximum allowed by CompanyCam API
      const maxProjects = 10000; // API limit for total projects
      let hasMorePages = true;

      while (hasMorePages && allProjects.length < maxProjects) {
        const response = await this.getProjectsList(page, perPage);

        if (response && response.length > 0) {
          allProjects.push(...response);
          page++;

          // Check if we've reached the API limit
          if (allProjects.length >= maxProjects) {
            console.warn(
              `Reached CompanyCam API limit of ${maxProjects} projects`,
            );
            break;
          }
        } else {
          // Empty response means no more pages
          hasMorePages = false;
        }
      }

      return allProjects.filter((project) => project.status != "deleted");
    } catch (error) {
      throw new Error(`Failed to fetch all projects: ${error.message}`);
    }
  }

  async getProjectMembers(projectId: string) {
    try {
      const response = await this.makeRequest<CompanyCamUser[]>(
        `${this.apiBaseUrl}/projects/${projectId}/assigned_users`,
      );
      return response;
    } catch (error) {
      throw new Error(
        `Failed to fetch project members for project ${projectId}: ${error.message}`,
      );
    }
  }

  async getProjectTags(projectId: string) {
    try {
      const response = await this.makeRequest<CompanyCamProjectLabels[]>(
        `${this.apiBaseUrl}/projects/${projectId}/labels`,
      );
      return response;
    } catch (error) {
      throw new Error(
        `Failed to fetch project members for project ${projectId}: ${error.message}`,
      );
    }
  }

  async getProjectNotes(projectId: string) {
    try {
      const response = await this.makeRequest<CompanyCamProjectNotes[]>(
        `${this.apiBaseUrl}/projects/${projectId}/comments`,
      );
      return response;
    } catch (error) {
      throw new Error(
        `Failed to fetch project members for project ${projectId}: ${error.message}`,
      );
    }
  }

  async getProjectFiles(projectId: string, page?: number, perPage?: number) {
    try {
      let url = `${this.apiBaseUrl}/projects/${projectId}/documents`;
      if (page && perPage) {
        url += `?page=${page}&per_page=${perPage}`;
      }
      const response = await this.makeRequest<CompanyCamProjectFiles[]>(url);
      return response;
    } catch (error: any) {
      throw new Error(
        `Failed to fetch project files for project ${projectId}: ${error.message}`,
      );
    }
  }

  async getAllProjectFiles(projectId: string) {
    try {
      const allFiles: CompanyCamProjectFiles[] = [];
      let page = 1;
      const perPage = 100; // Maximum allowed for documents endpoint
      let hasMorePages = true;

      while (hasMorePages) {
        const response = await this.getProjectFiles(projectId, page, perPage);

        if (response && response.length > 0) {
          allFiles.push(...response);
          page++;
        } else {
          // Empty response means no more pages
          hasMorePages = false;
        }
      }

      return allFiles;
    } catch (error: any) {
      throw new Error(
        `Failed to fetch all project files for project ${projectId}: ${error.message}`,
      );
    }
  }

  //photos
  async getProjectPosts(projectId: string, page?: number, perPage?: number) {
    try {
      let url = `${this.apiBaseUrl}/projects/${projectId}/photos`;
      if (page && perPage) {
        url += `?page=${page}&per_page=${perPage}`;
      }
      const response = await this.makeRequest<CompanyCamPhotos[]>(url);
      return response;
    } catch (error: any) {
      throw new Error(
        `Failed to fetch project photos for project ${projectId}: ${error.message}`,
      );
    }
  }

  async getAllProjectPosts(projectId: string) {
    try {
      const allPosts: CompanyCamPhotos[] = [];
      let page = 1;
      const perPage = 100; // Maximum allowed for photos endpoint
      let hasMorePages = true;

      while (hasMorePages) {
        const response = await this.getProjectPosts(projectId, page, perPage);

        if (response && response.length > 0) {
          allPosts.push(...response);
          page++;
        } else {
          // Empty response means no more pages
          hasMorePages = false;
        }
      }

      return allPosts.filter((post) => post.status != "deleted");
    } catch (error: any) {
      throw new Error(
        `Failed to fetch all project photos for project ${projectId}: ${error.message}`,
      );
    }
  }

  async getPhotoTags(photoId: string) {
    try {
      const response = await this.makeRequest<CompanyCamProjectLabels[]>(
        `${this.apiBaseUrl}/photos/${photoId}/tags`,
      );
      return response;
    } catch (error) {
      throw new Error(
        `Failed to fetch project members for project ${photoId}: ${error.message}`,
      );
    }
  }

  async getPhotoComments(photoId: string) {
    try {
      const response = await this.makeRequest<CompanyCamComments[]>(
        `${this.apiBaseUrl}/photos/${photoId}/comments`,
      );
      return response;
    } catch (error) {
      throw new Error(
        `Failed to fetch project members for project ${photoId}: ${error.message}`,
      );
    }
  }

  //checklists
  async getProjectChecklists(projectId: string) {
    try {
      const response = await this.makeRequest<CompanyCamChecklist[]>(
        `${this.apiBaseUrl}/projects/${projectId}/checklists`,
      );
      return response;
    } catch (error) {
      throw new Error(
        `Failed to fetch project checklists for project ${projectId}: ${error.message}`,
      );
    }
  }
}
