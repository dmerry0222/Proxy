import requests

CANVAS_URL = "https://canvas.suffolk.edu/"
ACCESS_TOKEN = "15414~yGLfwCH77w7k9cwXrwxZWaXPmyx86mTkDMCn9v4GNfEfy6RBNBzcAfK74Km8ZHwC"

COURSE_ID = 17391
ASSIGNMENT_ID = 249189

# Set to False after verifying the output
DRY_RUN = True

headers = {
    "Authorization": f"Bearer {ACCESS_TOKEN}"
}

url = (
    f"{CANVAS_URL}/api/v1/courses/{COURSE_ID}"
    f"/assignments/{ASSIGNMENT_ID}/submissions"
)

params = {"per_page": 100}

while url:
    response = requests.get(
        url,
        headers=headers,
        params=params
    )
    response.raise_for_status()

    submissions = response.json()

    for submission in submissions:
        student_id = submission["user_id"]

        if (
            submission["workflow_state"] == "submitted"
            and submission["grade"] is None
        ):
            if DRY_RUN:
                print(f"Would mark student {student_id} complete")
            else:
                grade_url = (
                    f"{CANVAS_URL}/api/v1/courses/{COURSE_ID}"
                    f"/assignments/{ASSIGNMENT_ID}"
                    f"/submissions/{student_id}"
                )

                grade_response = requests.put(
                    grade_url,
                    headers=headers,
                    data={
                        "submission[posted_grade]": "complete"
                    }
                )

                grade_response.raise_for_status()

                print(f"Marked student {student_id} complete")

    # Canvas pagination
    url = response.links.get("next", {}).get("url")

    # The next URL already contains its query parameters
    params = None