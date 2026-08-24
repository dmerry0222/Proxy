const response =
  await fetch(
    "http://localhost:3000/api/memory/ingest-test",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify({
        outlookMessageId:
          "AQMkADZhNjAzNDA5LTM1MjEtNDA3OC1hNTY5LTUzNjQ4NjNjN2RjMwBGAAAD9ySK1_g5kEKnMOxgUea1yAcA5UGpwriSjEC6oQP4RzkLmgAAAgEMAAAA5UGpwriSjEC6oQP4RzkLmgAF4oTJEwAAAA==",
      }),
    }
  );

console.log(
  await response.json()
);